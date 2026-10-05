from django.urls import path
from core import views as v
from core import access as a, marketing as m
from core import access_lifecycle as life
from core import design_review as dr
from core import demo_flow as demo
from core import demo_debits
handler403 = "core.errors.permission_denied"
handler404 = "core.errors.not_found"

urlpatterns = [
    path("access/settings/", life.staff_settings),
    path("access/refunds/<int:pk>/", life.staff_refund),
    path("access/email-fallback/", life.email_fallback),
    path("access/email-code/", life.email_code),
    path("access/fresh/", life.fresh),
    path("access/invitations/", life.invitations),
    path("access/invitations/<int:pk>/revoke/", life.revoke),
    path("access/invitation/<str:raw>/", life.accept),
    path("access/enrol/", life.enrol),
    path("access/reset/", life.reset_request),
    path("access/reset/<str:raw>/", life.reset_complete),
    path("access/workspace/", life.workspace),
    path("access/continue/", life.continue_session),
    path("__design/",dr.index),
    path("__design/today/",dr.today),
    path("",m.landing,name="landing"),
    path("today/",v.home,name="today"),
    path("demo/",m.demo,name="demo"),
    path("demo/start/",demo.start,name="demo_start"),
    path("demo/restart/",demo.restart,name="demo_restart"),
    path("demo/guide/",demo.guide,name="demo_guide"),
    path("demo/guide/action/",demo.action,name="demo_action"),
    path("demo/guide/end/",demo.end_tour,name="demo_end_tour"),
    path("demo/debits/run/",demo_debits.run,name="demo_debits"),
    path("request-demo/",m.lead,name="request_demo"),
    path("access/login/",a.signin,name="access_login"),
    path("access/challenge/",a.challenge,name="access_challenge"),
    path("access/organisations/",a.organisations,name="access_organisations"),
    path("access/help/",a.help_access,name="access_help"),
    path("access/logout/",a.signout,name="access_logout"),
    path("customers/",v.customers,name="customers"),
    path("customers/new/",v.customer_form,name="customer_new"),
    path("customers/<int:pk>/",v.customer_detail,name="customer_detail"),
    path("customers/<int:pk>/edit/",v.customer_form,name="customer_edit"),
    path("import/",v.import_customers,name="import"),
    path("loans/<int:pk>/action/",v.loan_action,name="loan_action"),
    path("collections/",v.collections,name="collections"),
    path("payments/",v.payments,name="payments"),
    path("payments/new/",v.request_form,name="request_new"),
    path("payments/<int:pk>/",v.request_detail,name="request_detail"),
    path("payments/<int:pk>/cancel/",v.cancel_request,name="request_cancel"),
    path("reviews/",v.reviews,name="reviews"),
    path("reviews/<int:pk>/",v.review_detail,name="review_detail"),
    path("refunds/<int:pk>/new/",v.refund_form,name="refund_new"),
    path("reports/",v.reports,name="reports"),
    path("settings/",v.settings,name="settings"),
    path("demo-role/",v.demo_role,name="demo_role"),
    path("credit/",v.preview,{"workspace":"credit"},name="credit"),
    path("cash/",v.preview,{"workspace":"cash"},name="cash"),
    path("consent/<str:token>/",v.public,{"kind":"consent"},name="consent"),
    path("pay/<str:token>/",v.public,{"kind":"payment"},name="pay"),
    path("exports/<str:kind>/",v.exports,name="export"),
]