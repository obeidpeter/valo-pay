"""Review deadlines in WAT. No holiday coverage is inferred or downloaded."""
from datetime import date, timedelta
from zoneinfo import ZoneInfo

from django.conf import settings
from django.utils import timezone
from django.utils.dateparse import parse_datetime

WAT = ZoneInfo("Africa/Lagos")
TARGETS = {"Unknown result": 1, "Refund request": 2, "Refund after withdrawal": 5}
UNAVAILABLE = (
    "Verified deadline unavailable: approved Nigerian holiday-calendar coverage is missing "
    "or invalid. No deadline-dependent request or approval can be saved. "
    "Ask an authorised operator to configure an approved, complete calendar; dates are not estimated."
)
# Explicit demonstration fixture only; absence of holidays here is not a claim about Nigeria.
DEMO_CALENDAR = {
    "reference": "Synthetic demo fixture — NOT an approved Nigerian holiday calendar",
    "coverage_start": "2020-01-01", "coverage_end": "2100-12-31",
    "holidays": [], "complete": True, "approved": False,
}


class CalendarUnavailable(ValueError):
    pass


def review_deadline(kind, started_at=None, *, synthetic=False):
    started_at = started_at or timezone.now()
    calendar = DEMO_CALENDAR if synthetic else getattr(settings, "REVIEW_BUSINESS_CALENDAR", None)
    try:
        if not isinstance(calendar, dict) or calendar.get("complete") is not True:
            raise ValueError
        if not synthetic and calendar.get("approved") is not True:
            raise ValueError
        reference = calendar["reference"]
        if not isinstance(reference, str) or not reference.strip():
            raise ValueError
        start, end = date.fromisoformat(calendar["coverage_start"]), date.fromisoformat(calendar["coverage_end"])
        if not isinstance(calendar["holidays"], list):
            raise ValueError
        holidays = {date.fromisoformat(day) for day in calendar["holidays"]}
        if start > end or any(day < start or day > end for day in holidays) or timezone.is_naive(started_at):
            raise ValueError
        current = started_at.astimezone(WAT)
        if not start <= current.date() <= end:
            raise ValueError
        target = TARGETS.get(kind, 3)
        remaining = target
        while remaining:
            current += timedelta(days=1)
            # Check every traversed day, including weekends. Never assume unknown coverage.
            if current.date() > end:
                raise ValueError
            if current.weekday() < 5 and current.date() not in holidays:
                remaining -= 1
        return current, {
            "status": "synthetic" if synthetic else "approved",
            "reference": reference, "coverage_start": start.isoformat(), "coverage_end": end.isoformat(),
            "holidays": sorted(day.isoformat() for day in holidays),
            "started_at": started_at.astimezone(WAT).isoformat(),
            "business_days": target, "kind": kind,
        }
    except (ValueError, TypeError, KeyError, AttributeError):
        raise CalendarUnavailable(UNAVAILABLE) from None


def approval_deadline_error(review):
    """Revalidate provenance without changing the historical deadline or its snapshot."""
    try:
        if review.deadline_basis.get("status") != "approved":
            raise CalendarUnavailable(UNAVAILABLE)
        deadline, basis = review_deadline(review.kind, parse_datetime(review.deadline_basis["started_at"]))
        if deadline != review.deadline or basis != review.deadline_basis:
            raise CalendarUnavailable(UNAVAILABLE)
    except (CalendarUnavailable, ValueError, TypeError, KeyError, AttributeError):
        return UNAVAILABLE + " The stored deadline is retained, but is not currently verified for approval."
    return ""


def calendar_notice(*, synthetic=False):
    try:
        _, basis = review_deadline("Refund request", synthetic=synthetic)
    except CalendarUnavailable as exc:
        return str(exc)
    return (
        f"{basis['reference']}. Coverage {basis['coverage_start']} to {basis['coverage_end']}. "
        "Targets: Unknown 1, refund request 2, other reviews 3, refund after withdrawal 5 business days. "
        "Exclude the opening day, weekends and configured holidays; retain the opening WAT time. "
        "Each proposed deadline must stay within coverage. Historical deadlines are not recalculated."
    )