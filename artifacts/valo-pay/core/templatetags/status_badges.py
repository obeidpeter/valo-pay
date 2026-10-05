"""Presentation-only mapping of stored status words to TRD 8.3 colour + icon. No logic changes."""
from django import template
from core.content import STATE_LABEL

register = template.Library()

# TRD 8.3 "Status words" table (authoritative). Words are displayed unchanged.
_MAP = {
    "active": ("ok", "tick"), "confirmed": ("ok", "tick"),
    "refunded": ("neutral", "return"), "reversed": ("err", "return"),
    "failed": ("err", "cross"), "rejected": ("err", "cross"),
    "unknown": ("warn", "question"), "missing": ("warn", "question"), "unresolved": ("warn", "question"),
    "on-hold": ("warn", "pause"), "hold": ("warn", "pause"), "paused": ("warn", "pause"),
    "awaiting-approval": ("neutral", "clock"), "awaiting-confirmation": ("neutral", "clock"),
    "awaiting-bank": ("neutral", "clock"), "sent": ("neutral", "clock"), "processing": ("neutral", "clock"),
    "pending": ("neutral", "clock"), "requested": ("neutral", "clock"),
    "withdrawn": ("neutral", "dash"), "expired": ("neutral", "dash"), "cancelled": ("neutral", "dash"),
    "closed": ("neutral", "dash"),
    "overdue": ("err", "exclaim"),
    "upcoming": ("neutral", "dot"), "due": ("info", "dot"), "paid": ("ok", "dot"),
    "part-paid": ("warn", "dot"), "partially-paid": ("warn", "dot"), "partial": ("warn", "dot"),
    "open": ("warn", "dot"), "in-progress": ("info", "dot"), "resolved": ("ok", "dot"),
    "dismissed": ("neutral", "dot"), "approved": ("ok", "dot"), "completed": ("ok", "dot"),
    "not-requested": ("neutral", "dot"),
}


@register.filter
def status_word(word):
    """The word people read for a stored status: the TRD word, or its plain name where the owner chose one."""
    return STATE_LABEL.get(str(word), word)


@register.filter
def status_tone(slug):
    return _MAP.get(str(slug), ("neutral", "dot"))[0]


@register.filter
def status_icon(slug):
    return _MAP.get(str(slug), ("neutral", "dot"))[1]
