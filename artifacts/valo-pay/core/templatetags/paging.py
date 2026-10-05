from django import template

register = template.Library()


@register.simple_tag(takes_context=True)
def page_url(context, number, parameter="page"):
    query = context["request"].GET.copy()
    query[parameter] = str(number)
    return "?" + query.urlencode()