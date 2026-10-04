from datetime import timedelta
from io import StringIO
from django.apps import apps
from django.contrib.sessions.models import Session
from django.core.management import call_command
from django.test import TestCase
from django.utils import timezone
from core.models import Organisation, Instalment, PaymentRequest, Audit
from core.services import PURGE_ORDER, purge_demo_workspaces, seed_demo
from .base import WorkspaceTestCase


class NoWorkspaceTests(TestCase):
    """Visits without a workspace (crawlers, link previews, health checks) must not write anything."""

    def test_home_shows_start_page_and_writes_nothing(self):
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertTemplateUsed(response, "start.html")
        self.assertContains(response, "Open the demo workspace")
        self.assertEqual(Organisation.objects.count(), 0)
        self.assertEqual(Session.objects.count(), 0)

    def test_head_request_writes_nothing(self):
        self.assertEqual(self.client.head("/").status_code, 200)
        self.assertEqual(Organisation.objects.count(), 0)

    def test_staff_pages_redirect_to_start_page(self):
        for url in ["/customers/", "/collections/", "/reviews/", "/settings/", "/credit/", "/exports/payments/"]:
            response = self.client.get(url)
            self.assertRedirects(response, "/", fetch_redirect_response=False, msg_prefix=url)
        self.assertEqual(self.client.post("/demo-role/", {"member": "1"}).status_code, 302)
        self.assertEqual(Organisation.objects.count(), 0)

    def test_get_start_does_not_create_a_workspace(self):
        response = self.client.get("/start/")
        self.assertTemplateUsed(response, "start.html")
        self.assertContains(response, "Open the demo workspace")
        self.assertEqual(Organisation.objects.count(), 0)

    def test_start_creates_exactly_one_demo_workspace(self):
        self.assertRedirects(self.client.post("/start/"), "/", fetch_redirect_response=False)
        self.client.post("/start/")
        org = Organisation.objects.get()
        self.assertTrue(org.demo)
        self.assertTemplateUsed(self.client.get("/"), "today.html")


class WorkspaceLifecycleTests(WorkspaceTestCase):
    def test_post_after_workspace_ended_is_explained(self):
        purge_demo_workspaces(idle_for=timedelta(0))
        response = self.client.post("/demo-role/", {"member": "1"}, follow=True)
        self.assertTemplateUsed(response, "start.html")
        self.assertIn("has ended", " ".join(self.messages_in(response)))

    def test_activity_refreshes_last_seen(self):
        stale = timezone.now() - timedelta(hours=1)
        Organisation.objects.filter(pk=self.org.pk).update(last_seen_at=stale)
        self.client.get("/customers/")
        self.org.refresh_from_db()
        self.assertGreater(self.org.last_seen_at, timezone.now() - timedelta(minutes=1))

    def test_expiry_is_recorded_by_the_system_not_the_viewer(self):
        inst = Instalment.objects.filter(organisation=self.org, paid=0, loan__on_hold=False).first()
        item = PaymentRequest.objects.create(organisation=self.org, instalment=inst, amount=100, reference="VP-TEST-EXPIRY",
                                             expires_at=timezone.now() - timedelta(minutes=1))
        self.client.get("/payments/")
        item.refresh_from_db()
        self.assertEqual(item.status, "Expired")
        self.assertEqual(Audit.objects.get(organisation=self.org, action="Payment request expired").actor_name, "System")

    def test_starting_a_workspace_purges_idle_ones(self):
        idle, _ = seed_demo()
        Organisation.objects.filter(pk=idle.pk).update(last_seen_at=timezone.now() - timedelta(days=2))
        self.client_class().post("/start/")
        self.assertFalse(Organisation.objects.filter(pk=idle.pk).exists())
        self.assertTrue(Organisation.objects.filter(pk=self.org.pk).exists())


class PurgeTests(TestCase):
    def make(self, idle_days, demo=True):
        org, _ = seed_demo()
        Organisation.objects.filter(pk=org.pk).update(last_seen_at=timezone.now() - timedelta(days=idle_days), demo=demo)
        return org

    def test_purges_only_idle_demo_workspaces_and_all_their_rows(self):
        idle, recent, real = self.make(2), self.make(0), self.make(2, demo=False)
        self.assertEqual(purge_demo_workspaces(), 1)
        self.assertFalse(Organisation.objects.filter(pk=idle.pk).exists())
        for model in PURGE_ORDER:
            self.assertFalse(model.objects.filter(organisation_id=idle.pk).exists(), model.__name__)
        self.assertEqual(Organisation.objects.filter(pk__in=[recent.pk, real.pk]).count(), 2)

    def test_purge_order_covers_every_tenant_model(self):
        tenant_models = {m for m in apps.get_app_config("core").get_models()
                         if any(f.is_relation and f.related_model is Organisation for f in m._meta.fields)}
        self.assertEqual(tenant_models, set(PURGE_ORDER))

    def test_limit_caps_one_run(self):
        for _ in range(3):
            self.make(2)
        self.assertEqual(purge_demo_workspaces(limit=2), 2)
        self.assertEqual(Organisation.objects.count(), 1)

    def test_management_command(self):
        self.make(2)
        out = StringIO()
        call_command("purge_demo_workspaces", stdout=out)
        self.assertIn("Deleted 1 idle demo workspace.", out.getvalue())
        self.make(0)
        call_command("purge_demo_workspaces", "--idle-hours", "0", stdout=out)
        self.assertEqual(Organisation.objects.count(), 0)
