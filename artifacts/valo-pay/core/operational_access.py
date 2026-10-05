import time
from django.db import transaction
from django.core.exceptions import PermissionDenied
from urllib.parse import urlencode
from django.contrib.auth import logout
from django.shortcuts import redirect


PREFIXES=("/today/","/customers/","/import/","/collections/","/payments/","/reviews/","/reports/","/settings/","/exports/","/loans/","/refunds/","/demo-role/","/credit/","/cash/")


class OperationalAccess:
    def __init__(self,get_response):
        self.get_response=get_response

    def __call__(self,request):
        from .access_services import safe_next, deliberate_navigation
        operational=request.path.startswith(PREFIXES)
        staff=request.user.is_authenticated
        if not staff and request.session.get("demo_flow_org") and (operational or request.path.startswith("/demo/guide/")):
            from .demo_flow import available
            if not available(request):
                return redirect("/demo/")
            if request.method == "POST" or deliberate_navigation(request):
                request.session["demo_idle_at"] = time.time()
        if operational:
            if staff and (not request.session.get("verified_at") or time.time()-request.session.get("staff_idle_at",0)>=1800):
                logout(request)
                return redirect("/access/login/?"+urlencode({"next":safe_next(request.get_full_path()),"expired":"1"}))
            if staff and not request.session.get("staff_org"):
                request.session["post_org_next"]=safe_next(request.get_full_path())
                return redirect("/access/organisations/")
            if not staff and not(request.session.get("demo_mode") or request.session.get("org")):
                return redirect("/access/login/?"+urlencode({"next":safe_next(request.get_full_path())}))
        if operational and request.method=="POST":
            from .models import Organisation, StaffMembership
            with transaction.atomic():
                org_id=request.session.get("staff_org") if staff else request.session.get("org")
                if org_id:
                    Organisation.objects.select_for_update().filter(pk=org_id).first()
                if staff:
                    if not StaffMembership.objects.select_for_update().filter(user=request.user,organisation_id=org_id,active=True).exists():
                        from .errors import permission_denied
                        return permission_denied(request)
                response=self.get_response(request)
        else:
            if operational and staff and deliberate_navigation(request):
                from .access_services import membership
                try:
                    membership(request)
                except PermissionDenied:
                    from .errors import permission_denied
                    return permission_denied(request)
                request.session["staff_idle_at"]=time.time()
            response=self.get_response(request)
        if operational and staff and (request.method=="POST" or deliberate_navigation(request)) and response.status_code<400:
            request.session["staff_idle_at"]=time.time()
        return response