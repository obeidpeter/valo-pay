import hashlib
import re
import time
from concurrent.futures import ThreadPoolExecutor
from django.contrib.auth import get_user_model
from django.core import mail
from django.db import close_old_connections, connections
from django.test import Client, TestCase, TransactionTestCase, override_settings
from django_otp.oath import totp
from django_otp.plugins.otp_totp.models import TOTPDevice
from .models import Organisation, StaffMembership, AccessToken
from .access_services import issue

PASSWORD = "Synthetic-only-a-long-phrase-2026"
TEST_SETTINGS = dict(ACCESS_TEST_DELIVERY=True,
    EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend",
    BREACHED_PASSWORD_SHA1=[hashlib.sha1(b"breached-fixture-passphrase").hexdigest()])


def prepare_admin(client):
    org = Organisation.objects.create(name="Synthetic Staff Org")
    user = get_user_model().objects.create_user("admin@example.invalid", email="admin@example.invalid", password=PASSWORD)
    member = StaffMembership.objects.create(user=user, organisation=org, role="Admin")
    client.force_login(user)
    session = client.session
    session.update({"verified_at": time.time(), "staff_idle_at": time.time(), "staff_org": str(org.pk)})
    session.save()
    return org, user, member


@override_settings(**TEST_SETTINGS)
class AccessJourneyTests(TestCase):
    def setUp(self):
        self.org, self.admin, self.member = prepare_admin(self.client)

    def invite(self):
        response = self.client.post("/access/invitations/", {"email": "new@example.invalid", "role": "Reviewer"})
        self.assertEqual(response.status_code, 200)
        return re.search(r"/access/invitation/[^/]+/", mail.outbox[-1].body).group()

    def new_account(self):
        path = self.invite()
        client = Client()
        response = client.post(path, {"password": PASSWORD, "confirm_password": PASSWORD})
        self.assertEqual(response.url, "/access/enrol/")
        user = get_user_model().objects.get(username="new@example.invalid")
        return client, user, path

    def enrolled(self):
        client, user, path = self.new_account()
        client.get("/access/enrol/")
        device = TOTPDevice.objects.get(user=user)
        self.assertFalse(device.confirmed)
        code = str(totp(device.bin_key)).zfill(6)
        response = client.post("/access/enrol/", {"code": code})
        self.assertEqual(response.url, "/access/organisations/")
        return client, user, device, code

    def test_complete_invite_enrol_select_logout(self):
        client, user, device, _ = self.enrolled()
        device.refresh_from_db()
        self.assertTrue(device.confirmed)
        self.assertGreaterEqual(device.last_t, 0)
        m = StaffMembership.objects.get(user=user)
        self.assertEqual(client.post("/access/organisations/", {"organisation": m.pk}).url, "/today/")
        self.assertContains(client.get("/access/workspace/"), "Reviewer")
        self.assertEqual(client.get("/access/logout/").status_code, 405)
        self.assertEqual(client.post("/access/logout/").status_code, 302)
        self.assertNotIn("_auth_user_id", client.session)

    def test_invite_single_use(self):
        client, user, path = self.new_account()
        self.assertContains(client.post(path, {"password": PASSWORD, "confirm_password": PASSWORD}), "already been used")
        self.assertEqual(StaffMembership.objects.filter(user=user).count(), 1)

    def test_revoked_invite(self):
        path = self.invite()
        token = AccessToken.objects.get(purpose="invite")
        self.client.post(f"/access/invitations/{token.pk}/revoke/")
        self.assertContains(Client().get(path), "revoked")

    def test_existing_identity_cannot_be_taken_over(self):
        path = self.invite()
        user = get_user_model().objects.create_user("new@example.invalid", password=PASSWORD)
        original = user.password
        response = Client().post(path, {"password": "another-password"})
        self.assertTrue(response.url.startswith("/access/login/"))
        user.refresh_from_db()
        self.assertEqual(user.password, original)
        self.assertFalse(AccessToken.objects.get(purpose="invite").consumed_at)

    def test_existing_authenticated_identity_accepts_without_password_change(self):
        path = self.invite()
        user = get_user_model().objects.create_user("new@example.invalid", email="new@example.invalid", password=PASSWORD)
        device = TOTPDevice.objects.create(user=user, confirmed=True)
        original_password, original_key = user.password, device.key
        client = Client()
        client.post("/access/login/?next="+path, {"email":user.username, "password":PASSWORD})
        response = client.post("/access/challenge/",{"code":str(totp(device.bin_key)).zfill(6)})
        self.assertEqual(response.url,path)
        self.assertEqual(client.post(path,{"confirm":"1"}).url,"/access/organisations/")
        user.refresh_from_db()
        device.refresh_from_db()
        self.assertEqual(user.password,original_password)
        self.assertEqual(device.key,original_key)
        self.assertTrue(StaffMembership.objects.filter(user=user,organisation=self.org,role="Reviewer").exists())

    def test_password_is_argon2id_and_auth_referrer_policy_safe(self):
        self.assertTrue(self.admin.password.startswith("argon2$argon2id$"))
        response = Client().get("/access/login/")
        self.assertEqual(response["Referrer-Policy"],"same-origin")
        self.assertNotContains(response,'name="referrer" content="no-referrer"')

    def test_totp_replay_fails_across_sessions(self):
        client, user, device, code = self.enrolled()
        other = Client()
        other.post("/access/login/", {"email": user.username, "password": PASSWORD})
        response = other.post("/access/challenge/", {"code": code})
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("_auth_user_id", other.session)

    def test_email_fallback_is_single_use_and_session_bound(self):
        client, user, device, code = self.enrolled()
        other = Client()
        other.post("/access/login/", {"email": user.username, "password": PASSWORD})
        self.assertEqual(other.post("/access/email-fallback/").status_code, 302)
        raw = mail.outbox[-1].body
        stranger = Client()
        stranger.post("/access/login/", {"email": user.username, "password": PASSWORD})
        self.assertEqual(stranger.post("/access/email-code/", {"code": raw}).status_code, 200)
        self.assertNotIn("_auth_user_id", stranger.session)
        self.assertEqual(other.post("/access/email-code/", {"code": raw}).status_code, 302)
        self.assertTrue(AccessToken.objects.get(purpose="email").consumed_at)

    def test_reset_preserves_mfa_and_invalidates_pending_auth(self):
        client, user, device, code = self.enrolled()
        pending = Client()
        pending.post("/access/login/", {"email": user.username, "password": PASSWORD})
        reset = Client()
        reset.post("/access/reset/", {"email": user.username})
        path = re.search(r"/access/reset/[^/]+/", mail.outbox[-1].body).group()
        new = PASSWORD+"-changed"
        response = reset.post(path, {"password": new, "confirm_password": new})
        self.assertEqual(response.url, "/access/login/")
        self.assertNotIn("_auth_user_id", reset.session)
        self.assertContains(reset.get(path), "already used")
        self.assertEqual(pending.post("/access/challenge/", {"code": code}).url, "/access/login/")
        self.assertTrue(TOTPDevice.objects.get(pk=device.pk).confirmed)
        self.assertEqual(reset.post("/access/login/", {"email": user.username, "password": new}).url, "/access/challenge/")
        self.assertNotIn("_auth_user_id", reset.session)

    def test_password_validation_common_length_breach(self):
        path = self.invite()
        for password in ("short", "password123456", "breached-fixture-passphrase"):
            response = Client().post(path, {"password": password, "confirm_password": password})
            self.assertEqual(response.status_code, 200)
            self.assertFalse(get_user_model().objects.filter(username="new@example.invalid").exists())

    def test_membership_revoked_next_request(self):
        self.member.active = False
        self.member.save()
        self.assertEqual(self.client.get("/access/workspace/").status_code, 403)
        self.assertEqual(self.client.post("/access/invitations/", {"email": "new@example.invalid", "role": "Admin"}).status_code, 403)

    def test_polling_does_not_extend_idle_and_expiry_enforced(self):
        before = self.client.session["staff_idle_at"]
        self.client.get("/access/workspace/")
        self.assertEqual(self.client.session["staff_idle_at"], before)
        session = self.client.session
        session["staff_idle_at"] = time.time()-1801
        session.save()
        self.assertEqual(self.client.post("/access/continue/").status_code, 302)
        self.assertNotIn("_auth_user_id", self.client.session)

    def test_cross_tenant_selection_and_safe_return(self):
        from .access_services import safe_next
        for destination in ("https://evil.example", "//evil.example", "/exports/audit/"):
            self.assertEqual(safe_next(destination), "/access/organisations/")
        org = Organisation.objects.create()
        other = get_user_model().objects.create_user("other@example.invalid")
        member = StaffMembership.objects.create(user=other, organisation=org, role="Admin")
        self.assertEqual(self.client.post("/access/organisations/", {"organisation": member.pk}).status_code, 200)
        self.assertEqual(self.client.session["staff_org"], str(self.org.pk))

    @override_settings(ACCESS_TEST_DELIVERY=False)
    def test_public_delivery_gate_rolls_back_invitation(self):
        response = self.client.post("/access/invitations/", {"email": "new@example.invalid", "role": "Reviewer"})
        self.assertContains(response, "Nothing was sent")
        self.assertEqual(AccessToken.objects.count(), 0)

    def test_generic_reset_response(self):
        a = Client().post("/access/reset/", {"email": "admin@example.invalid"})
        b = Client().post("/access/reset/", {"email": "missing@example.invalid"})
        self.assertEqual(a.context["notice"], b.context["notice"])

    def test_expired_invite_and_invalid_enrolment(self):
        from datetime import timedelta
        from django.utils import timezone
        path = self.invite()
        AccessToken.objects.update(expires_at=timezone.now()-timedelta(seconds=1))
        self.assertContains(Client().get(path), "expired")
        client, user, _ = self.new_account()
        self.assertEqual(client.post("/access/enrol/", {"code": "wrong!"}).status_code, 200)
        self.assertNotIn("_auth_user_id", client.session)
        self.assertFalse(TOTPDevice.objects.get(user=user).confirmed)

    def test_non_admin_cannot_issue_or_revoke(self):
        path = self.invite()
        token = AccessToken.objects.get(purpose="invite")
        self.member.role = "Viewer"
        self.member.save()
        self.assertEqual(self.client.get("/access/invitations/").status_code, 403)
        self.assertEqual(self.client.post(f"/access/invitations/{token.pk}/revoke/").status_code, 403)

    def test_csrf_on_authentication_mutations(self):
        client = Client(enforce_csrf_checks=True)
        for path in ("/access/login/", "/access/reset/", "/access/enrol/", "/access/logout/",
                     "/access/continue/", "/access/email-fallback/", "/access/fresh/"):
            self.assertEqual(client.post(path, {}).status_code, 403)

    def test_fresh_proof_bound_to_action_target_role_and_single_use(self):
        from django.test import RequestFactory
        from django.core.exceptions import PermissionDenied
        from .access_services import consume_fresh
        device = TOTPDevice.objects.create(user=self.admin, confirmed=True)
        response = self.client.post("/access/fresh/", {"code": str(totp(device.bin_key)).zfill(6),
            "action": "paystack-change", "target": "connection"})
        self.assertContains(response, "Identity rechecked")
        request = RequestFactory().post("/")
        request.user = self.admin
        request.session = self.client.session
        # Wrong target fails without consuming the DB token.
        with self.assertRaises(PermissionDenied):
            consume_fresh(request, "paystack-change", "another-connection")
        request.session = self.client.session
        self.assertEqual(consume_fresh(request, "paystack-change", "connection").pk, self.member.pk)
        request.session = self.client.session
        with self.assertRaises(PermissionDenied):
            consume_fresh(request, "paystack-change", "connection")

    def test_throttle_survives_cookie_changes(self):
        for _ in range(11):
            response = Client().post("/access/login/", {"email": "missing@example.invalid", "password": "invalid"})
        self.assertContains(response, "Too many attempts")

    def refund_fixture(self):
        from .test_business_days import APPROVED_TEST_CALENDAR
        from .business_days import review_deadline
        calendar_override=override_settings(REVIEW_BUSINESS_CALENDAR=APPROVED_TEST_CALENDAR)
        calendar_override.enable()
        self.addCleanup(calendar_override.disable)
        from .services import seed_demo
        from .models import Payment, Review, Refund
        org, preparer = seed_demo()
        maker = get_user_model().objects.create_user("maker@example.invalid")
        preparer.user = maker
        preparer.save()
        self.member.organisation = org
        self.member.save()
        session = self.client.session
        session["staff_org"] = str(org.pk)
        session.save()
        payment = Payment.objects.filter(organisation=org).first()
        review = Review.objects.create(organisation=org, instalment=payment.instalment,
            kind="Refund request", amount=100, owner=preparer, prepared_by=preparer,
            deadline=__import__("django.utils.timezone", fromlist=["now"]).now())
        review.deadline,review.deadline_basis=review_deadline(review.kind)
        review.save(update_fields=["deadline","deadline_basis"])
        refund = Refund.objects.create(organisation=org,payment=payment,review=review,amount=100,reason="Synthetic")
        return refund, preparer

    def fresh_for_refund(self, refund):
        device = TOTPDevice.objects.create(user=self.admin, confirmed=True)
        response = self.client.post("/access/fresh/", {"code":str(totp(device.bin_key)).zfill(6),
            "action":"refund-approval","target":str(refund.pk)})
        self.assertContains(response,"Identity rechecked")

    def test_refund_decision_fresh_verified_without_execution(self):
        refund, _ = self.refund_fixture()
        path = f"/access/refunds/{refund.pk}/"
        self.assertEqual(self.client.post(path,{"decision":"approve","note":"Synthetic"}).status_code,403)
        self.fresh_for_refund(refund)
        self.assertContains(self.client.post(path,{"decision":"Failed","note":"Synthetic"}),"Select a valid choice")
        self.assertContains(self.client.post(path,{"decision":"approve","note":"Synthetic"}),"Decision recorded")
        refund.refresh_from_db()
        self.assertEqual(refund.status,"Approved")
        self.assertContains(self.client.post(path,{"decision":"approve","note":"Repeated"}),"No decision was saved")

    def test_fresh_does_not_override_self_review_or_revocation(self):
        refund, preparer = self.refund_fixture()
        self.fresh_for_refund(refund)
        preparer.user = self.admin
        preparer.save()
        path = f"/access/refunds/{refund.pk}/"
        self.assertEqual(self.client.post(path,{"decision":"approve","note":"Synthetic"}).status_code,403)

    def test_legacy_review_post_cannot_approve_without_fresh_verification(self):
        refund,preparer=self.refund_fixture()
        response=self.client.post(f"/reviews/{refund.review_id}/",{"action":"resolve","outcome":"Resolved","note":"Synthetic"})
        self.assertEqual(response.url,f"/access/refunds/{refund.pk}/")
        refund.refresh_from_db()
        self.assertEqual(refund.status,"Requested")
        self.assertEqual(self.client.post(response.url,{"decision":"approve","note":"Synthetic"}).status_code,403)
        self.member.active = False
        self.member.save()
        self.assertEqual(self.client.post(response.url,{"decision":"approve","note":"Synthetic"}).status_code,403)


@override_settings(**TEST_SETTINGS)
class AccessConcurrencyTests(TransactionTestCase):
    def run_parallel(self, call):
        def run():
            close_old_connections()
            try:
                return call()
            finally:
                connections.close_all()
        with ThreadPoolExecutor(max_workers=2) as executor:
            return list(executor.map(lambda _: run(), range(2)))

    def test_invitation_consumed_once_postgresql(self):
        org = Organisation.objects.create()
        token, raw = issue("invite", "race@example.invalid", organisation=org, role="Viewer")
        responses = self.run_parallel(lambda: Client().post(f"/access/invitation/{raw}/",
            {"password": PASSWORD, "confirm_password": PASSWORD}).status_code)
        self.assertEqual(sorted(responses), [200, 302])
        self.assertEqual(get_user_model().objects.filter(username="race@example.invalid").count(), 1)

    def test_otp_timestep_consumed_once_postgresql(self):
        user = get_user_model().objects.create_user("race@example.invalid", password=PASSWORD)
        device = TOTPDevice.objects.create(user=user, confirmed=True)
        code = str(totp(device.bin_key)).zfill(6)
        def attempt():
            client = Client()
            client.post("/access/login/", {"email": user.username, "password": PASSWORD})
            return client.post("/access/challenge/", {"code": code}).status_code
        self.assertEqual(sorted(self.run_parallel(attempt)), [200, 302])