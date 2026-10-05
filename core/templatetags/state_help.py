from django import template
from core.content import STATE_HELP
register = template.Library()

@register.filter
def state_help(value):
    return STATE_HELP.get(value, "")