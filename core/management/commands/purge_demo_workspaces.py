from datetime import timedelta
from django.core.management.base import BaseCommand
from core.services import purge_demo_workspaces


class Command(BaseCommand):
    help = "Delete demo workspaces with no activity for DEMO_WORKSPACE_RETENTION (24 hours), and expired sessions. Schedule daily."

    def add_arguments(self, parser):
        parser.add_argument("--idle-hours", type=float, help="Delete workspaces idle at least this many hours instead.")

    def handle(self, *args, idle_hours=None, **options):
        count = purge_demo_workspaces(None if idle_hours is None else timedelta(hours=idle_hours))
        self.stdout.write(f"Deleted {count} idle demo workspace{'' if count == 1 else 's'}.")
