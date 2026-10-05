"""Development-only component review surface.

Fails closed: returns 404 whenever REPLIT_DEPLOYMENT=1 (read at request time and at settings load).
Renders only in-memory synthetic fixtures; never touches the database, providers or sessions.
"""
import os
from datetime import date, datetime
from types import SimpleNamespace as N
from django.conf import settings
from django.http import Http404
from django.shortcuts import render

FIXTURES = ("dense", "empty", "long", "large")


def _guard():
    if os.environ.get("REPLIT_DEPLOYMENT") == "1" or getattr(settings, "IS_PUBLISHED", False):
        raise Http404()


def _naira(kobo):
    n, k = divmod(kobo, 100)
    return f"₦{n:,}.{k:02d}"


def _today_context(fixture):
    long = fixture == "long"; large = fixture == "large"; empty = fixture == "empty"
    names = (["Oluwaseun Adébáyọ̀-Okonkwo Ìbídùnní (Synthetic)", "Chukwuemekaobinna Nwachukwu-Ezeoke (Synthetic)",
              "Ọlátúnjí Fọláshadé Àdìgún-Babátúndé (Synthetic)"] if long else
             ["Amara Okeke (Synthetic)", "Ìfẹ́olúwa Àlàbí (Synthetic)", "Chidi Nwosu (Synthetic)"])
    amt = (lambda i: 123456789012345 + i * 7) if large else (lambda i: 3500000 + i * 1250050)
    n_rev = 0 if empty else (9 if fixture == "dense" else 3)
    n_due = 0 if empty else (14 if fixture == "dense" else 3)
    n_pay = 0 if empty else (10 if fixture == "dense" else 4)
    statuses = ["Confirmed", "Pending", "Unknown", "Failed", "Missing"]
    reviews = [dict(id=i + 1, kind=["Unknown result", "Unclear match", "Refund approval"][i % 3],
                    customer_name=names[i % 3], overdue=i == 0, deadline=datetime(2026, 10, 6, 14, 30),
                    owner=None if i % 2 else N(name="Tunde Bello (Synthetic)"),
                    deadline_label="Synthetic business-day fixture — not a verified Nigerian deadline",
                    amount_display=_naira(amt(i))) for i in range(n_rev)]
    inst = [N(loan=N(customer=N(id=i + 1, name=names[i % 3]), reference=f"SYN-LN-{2040 + i}", on_hold=i == 2),
              status=["Due", "Partially paid", "On hold", "Unknown"][i % 4], outstanding_display=_naira(amt(i))) for i in range(n_due)]
    pays = [dict(customer_name=names[i % 3], reference=f"SYN-PAY-{9000 + i}", amount_display=_naira(amt(i) if i % 5 != 4 else 0),
                 status=statuses[i % 5]) for i in range(n_pay)]
    act = [] if empty else [N(created_at=datetime(2026, 10, 4, 9, 12), actor_name="Ada Okafor (Synthetic)",
                              action="Demo workspace created", detail="Synthetic examples loaded. Live payment processing is disabled.")]
    return dict(title="Dashboard", page="today", today=date(2026, 10, 4), staff_mode=False, can_prepare=True,
                org=N(name="Ìlú Àjọ Cooperative Multipurpose Society — Synthetic Review Fixture" if long else "Meridian Finance (Synthetic)"),
                actor=N(name="Ada Okafor (Synthetic)", role="Admin"), open_review_count=n_rev,
                metrics=dict(review_count=n_rev, failed_count=0 if empty else 2, held_count=0 if empty else 5,
                             collected_display=_naira(0 if empty else (987654321098765 if large else 46000000)),
                             confirmed_count=0 if empty else 8, due_display=_naira(sum(amt(i) for i in range(n_due))),
                             due_count=n_due, active_consents=0 if empty else 6, customer_count=0 if empty else 12),
                urgent_reviews=reviews, instalments=inst, recent_payments=pays, activity=act, design_fixture=fixture)


def index(request):
    _guard()
    return render(request, "design_review.html", {"fixtures": FIXTURES,
        "statuses": ["Active", "Confirmed", "Refunded", "Failed", "Reversed", "Unknown", "On hold",
                     "Awaiting approval", "Awaiting confirmation", "Awaiting bank", "Sent", "Processing",
                     "Withdrawn", "Expired", "Cancelled", "Overdue", "Upcoming", "Due", "Paid", "Part-paid",
                     "Open", "In progress", "Resolved", "Dismissed"],
        "amounts": [_naira(0), _naira(1), _naira(123456789012345), _naira(100000000000)]})


def today(request):
    _guard()
    fixture = request.GET.get("fixture", "dense")
    if fixture not in FIXTURES:
        raise Http404()
    return render(request, "today.html", _today_context(fixture))
