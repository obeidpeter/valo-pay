from django.contrib import messages
from django.shortcuts import redirect
from .services import WorkspaceRequired


class WorkspaceMiddleware:
    """Send staff requests without a live demo workspace to the start page (Today renders it)."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        return self.get_response(request)

    def process_exception(self, request, exception):
        if not isinstance(exception, WorkspaceRequired):
            return None
        if request.method == "POST":
            messages.warning(request, "Your demo workspace has ended (workspaces close after 30 minutes without activity), so that change was not saved.")
        return redirect("today")
