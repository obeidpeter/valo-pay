import csv
import logging
import uuid
from datetime import timedelta
from decimal import Decimal
from django.contrib import messages
from django.core.exceptions import PermissionDenied
from django.db import transaction, IntegrityError
from django.db.models import F, Prefetch, Q, Sum
from django.http import Http404, HttpResponse
from django.shortcuts import render, redirect, get_object_or_404
from django.utils import timezone
from django.views.decorators.http import require_POST
from .models import *
from . import content
from .forms import CustomerForm, RequestForm, RefundForm, SettingsForm
from .services import WorkspaceRequired, context, audit, month_date, validate_csv, commit_csv, seed_demo, workspace_exists, purge_demo_workspaces

logger = logging.getLogger(__name__)


def permitted(ctx, roles):
    if ctx["actor"].role not in roles:
        raise PermissionDenied("This simulated role is not permitted to perform this action.")


def lookup_or_404(queryset, pk):
    # IDs from query strings and forms are untrusted: anything that is not an integer is a 404, not a 500.
    try:
        pk = int(pk)
    except (TypeError, ValueError):
        raise Http404("No such record.")
    return get_object_or_404(queryset, pk=pk)


TITLES = {"today": "Today", "customers": "Customers", "customer_detail": "Customer", "customer_form": "Customer details", "import": "Import instalments",
          "collections": "Collections", "payments": "Pay-by-bank", "request_form": "New payment request", "request_detail": "Payment request",
          "reviews": "Reviews", "review_detail": "Review", "refund_form": "Request a refund", "reports": "Reports", "settings": "Settings"}


def page(request, template, ctx, **extra):
    ctx.update(extra)
    ctx.setdefault("page", template)
    ctx.setdefault("title", TITLES.get(template, template.replace("_"," ").capitalize()))
    return render(request, template+".html", ctx)


def metrics(org):
    due = Instalment.objects.filter(organisation=org, due_date=timezone.localdate())
    # The month starts at midnight in Lagos, not UTC (BR-13: stored in UTC, shown in WAT).
    month_start = timezone.localtime().replace(day=1,hour=0,minute=0,second=0,microsecond=0)
    payments = Payment.objects.filter(organisation=org, status="Confirmed", paid_at__gte=month_start)
    due_kobo = sum(i.amount-i.paid for i in due); collected_kobo = payments.aggregate(s=Sum("amount"))["s"] or 0
    return {"due_display":money(due_kobo), "due_kobo":due_kobo, "due_count":due.exclude(state="Paid").count(),
            "collected_display":money(collected_kobo), "collected_kobo":collected_kobo, "confirmed_count":payments.count(),
            "month_start":month_start, "loan_count":Loan.objects.filter(organisation=org).count(),
            "failed_count":Instalment.objects.filter(organisation=org,state="Failed").count(),
            "review_count":Review.objects.filter(organisation=org,status__in=["Open","In progress"]).count(),
            "held_count":Instalment.objects.filter(organisation=org,loan__on_hold=True).exclude(state="Paid").count(),
            "active_consents":Loan.objects.filter(organisation=org,consent_status="Active").count(),
            "customer_count":Customer.objects.filter(organisation=org).count()}


def home(request):
    try:
        c = context(request)
    except WorkspaceRequired:
        return render(request, "start.html")
    org = c["org"]
    return page(request,"today",c,metrics=metrics(org),
                recent_payments=Payment.objects.filter(organisation=org).select_related("instalment__loan__customer").order_by("-paid_at")[:6],
                urgent_reviews=Review.objects.filter(organisation=org,status__in=["Open","In progress"]).select_related("owner","instalment__loan__customer").order_by("deadline")[:4],
                instalments=Instalment.objects.filter(organisation=org,due_date=c["today"]).select_related("loan__customer"),
                activity=Audit.objects.filter(organisation=org)[:5])


def start(request):
    if request.method == "POST" and not workspace_exists(request):
        org, actor = seed_demo()
        request.session.cycle_key()
        request.session["org"] = str(org.id)
        request.session["actor"] = actor.id
        try:
            # Housekeeping only: a failure here must never stop a visitor opening the demo.
            purge_demo_workspaces(limit=10)
        except Exception:
            logger.exception("Purging idle demo workspaces failed")
    return redirect("today")


def customers(request):
    c=context(request); q=request.GET.get("q","").strip(); filt=request.GET.get("filter","")
    items=Customer.objects.filter(organisation=c["org"]).prefetch_related(Prefetch("loans",queryset=Loan.objects.order_by("id"))).order_by("name")
    if q:
        items=items.filter(Q(name__icontains=q)|Q(email__icontains=q)|Q(phone__icontains=q)|Q(external_id__icontains=q)|Q(loans__reference__icontains=q)).distinct()
    if filt=="hold": items=items.filter(loans__on_hold=True)
    if filt=="no-consent": items=items.exclude(loans__consent_status="Active")
    if filt=="overdue": items=items.filter(loans__instalments__due_date__lt=c["today"],loans__instalments__paid=0).distinct()
    return page(request,"customers",c,customers=items,q=q,filter=filt,filtered=bool(q or filt))


def customer_detail(request,pk):
    c=context(request); customer=get_object_or_404(Customer,pk=pk,organisation=c["org"])
    # A customer can hold several loans (CSV import allows it); the page covers all of them.
    loans=list(customer.loans.order_by("id").prefetch_related(Prefetch("instalments",queryset=Instalment.objects.order_by("sequence"))))
    # Loan audit details are "<ref>" or "<ref>: …", so match exactly: LN-1 must not pick up LN-10.
    mentions=Q(pk__in=[])
    for loan in loans: mentions|=Q(detail=loan.reference)|Q(detail__startswith=f"{loan.reference}:")
    return page(request,"customer_detail",c,title=customer.name,customer=customer,loans=loans,
                payments=Payment.objects.filter(organisation=c["org"],instalment__loan__customer=customer).select_related("instalment__loan"),
                reviews=Review.objects.filter(organisation=c["org"],instalment__loan__customer=customer),
                activity=Audit.objects.filter(organisation=c["org"]).filter(mentions))


def customer_form(request,pk=None):
    c=context(request); permitted(c,["Admin","Preparer"])
    customer=get_object_or_404(Customer,pk=pk,organisation=c["org"]) if pk else None
    initial={}
    if customer:
        # ?loan= picks which of the customer's loans to edit; default is the first.
        loan=lookup_or_404(customer.loans,request.GET["loan"]) if "loan" in request.GET else customer.loans.order_by("id").first()
        if loan is None: raise Http404("This customer has no loan to edit.")
        inst=loan.instalments.order_by("sequence").first()
        initial={"name":customer.name,"external_id":customer.external_id,"email":customer.email,"phone":customer.phone,
                 "loan_id":loan.reference,"product":loan.product,"amount":Decimal(inst.amount)/100,"due_date":inst.due_date,"instalment_count":loan.instalments.count()}
    form=CustomerForm(request.POST or None,initial=initial)
    if customer:
        for f in ["loan_id","amount","due_date","instalment_count"]:
            form.fields[f].disabled=True
            form.fields[f].help_text="You cannot change the schedule in this demo. In the live service, a change creates a new version of the schedule and the customer must be notified again."
    if request.method=="POST" and form.is_valid():
        d=form.cleaned_data
        try:
            with transaction.atomic():
                Organisation.objects.select_for_update().get(pk=c["org"].pk)
                if customer:
                    for key in ["name","external_id","email","phone"]: setattr(customer,key,d[key])
                    customer.save(); loan.product=d["product"]; loan.save()
                else:
                    customer=Customer.objects.create(organisation=c["org"],**{k:d[k] for k in ["name","external_id","email","phone"]})
                    amount=int(d["amount"]*100)
                    loan=Loan.objects.create(organisation=c["org"],customer=customer,reference=d["loan_id"],product=d["product"],consent_max=amount,consent_expiry=month_date(d["due_date"],d["instalment_count"]-1)+timedelta(days=30))
                    for n in range(d["instalment_count"]):
                        Instalment.objects.create(organisation=c["org"],loan=loan,sequence=n+1,due_date=month_date(d["due_date"],n),amount=amount)
                audit(c["org"],c["actor"],"Customer updated" if pk else "Customer created",loan.reference)
            messages.success(request,"Changes saved." if pk else f"Customer added, with {d['instalment_count']} instalment{'s' if d['instalment_count'] != 1 else ''} on loan {loan.reference}.")
            return redirect("customer_detail",pk=customer.pk)
        except IntegrityError:
            form.add_error(None,"That customer ID or loan ID is already used in your organisation. Use a different ID.")
    return page(request,"customer_form",c,form=form,customer=customer,title=f"Edit {customer.name}" if customer else "Add a customer")


def import_customers(request):
    c=context(request); permitted(c,["Admin","Preparer"])
    text=request.POST.get("csv_data","")
    errors=[]; rows=[]
    if request.method=="POST":
        errors,rows=validate_csv(text,c["org"])
        if request.POST.get("action")=="commit" and not errors:
            try:
                commit_csv(rows,c["org"],c["actor"])
                loans=len({r["loan_id"] for r in rows})
                messages.success(request,f"Imported {len(rows)} instalment{'s' if len(rows) != 1 else ''} for {loans} loan{'s' if loans != 1 else ''}.")
                return redirect("customers")
            except IntegrityError:
                errors=["Nothing was imported, because some customer or loan IDs in this file are now already in use. Check the file again to see which rows."]
    return page(request,"import",c,csv_data=text,errors=errors,preview=rows[:50],row_count=len(rows),validated=bool(rows) and not errors)


@require_POST
@transaction.atomic
def loan_action(request,pk):
    c=context(request); action=request.POST.get("action"); reason=request.POST.get("reason","").strip()
    loan=get_object_or_404(Loan.objects.select_for_update(),pk=pk,organisation=c["org"])
    if action=="release": permitted(c,["Admin","Reviewer"])
    elif action=="hold": permitted(c,["Admin","Preparer","Reviewer"])
    else: permitted(c,["Admin","Preparer"])
    if action!="consent" and not reason:
        messages.error(request,"Enter a reason. It is saved in the loan's audit trail.")
    elif action=="consent":
        if loan.status!="Open": messages.error(request,"This loan is closed, so a consent link cannot be created for it.")
        elif loan.consent_status in ["Active","Awaiting bank"]: messages.error(request,f"This loan's consent is already {loan.consent_status}, so a new consent link is not needed.")
        else:
            loan.consent_status="Requested"; loan.consent_requested_at=timezone.now(); loan.consent_token=token(); loan.save()
            audit(c["org"],c["actor"],"Consent link created",loan.reference)
            messages.success(request,f"Consent link created for {loan.reference}. Copy it below and share it with the customer; it works for 14 days. Nothing was sent: this demo does not send emails.")
    elif action=="hold":
        if loan.status!="Open":
            messages.error(request,"This loan is closed, so it cannot be put on hold.")
        elif loan.on_hold:
            messages.error(request,"This loan is already on hold.")
        else:
            loan.on_hold=True; loan.hold_reason=reason; loan.held_by=c["actor"]; loan.save()
            audit(c["org"],c["actor"],"Loan held",f"{loan.reference}: {reason}")
            messages.success(request,f"{loan.reference} is on hold. No new payment requests can be created for it until a different person releases the hold.")
    elif action=="release":
        if not loan.on_hold:
            messages.error(request,"This loan is not on hold.")
        elif loan.held_by_id==c["actor"].id:
            messages.error(request,"You put this loan on hold, so a different person must release it.")
        elif loan.instalments.filter(state="Unknown").exists():
            messages.error(request,"This hold cannot be released yet. A payment on this loan has an Unknown result, and collection stays on hold until the final result is known.")
        else:
            loan.on_hold=False; loan.hold_reason=""; loan.save()
            audit(c["org"],c["actor"],"Hold released",f"{loan.reference}: {reason}")
            messages.success(request,f"Hold released. Payment requests can be created for {loan.reference} again." if loan.status=="Open" else
                             f"Hold released for {loan.reference}. The loan is closed, so payment requests still cannot be created for it.")
    elif action=="withdraw":
        if loan.consent_status in ["Active","Awaiting bank"]:
            messages.error(request,"Consent cannot be withdrawn in this demo. Withdrawing it means cancelling it at Paystack, and no Paystack account is connected. The consent is unchanged.")
        elif loan.consent_status!="Requested":
            messages.error(request,"This loan has no unused consent link to withdraw.")
        else:
            loan.consent_status="Withdrawn"; loan.save()
            audit(c["org"],c["actor"],"Unused consent link withdrawn",f"{loan.reference}: {reason}")
            messages.success(request,"Consent link withdrawn. The customer had not used it, and the link no longer works.")
    elif action=="close":
        if loan.status=="Closed":
            messages.error(request,"This loan is already closed.")
        # An Unknown result holds the instalment until it is resolved (BR-05, FR-P3.2).
        elif loan.instalments.filter(state__in=["Unknown","In progress"]).exists() or PaymentRequest.objects.filter(instalment__loan=loan,status__in=["Awaiting confirmation","Unknown"]).exists():
            messages.error(request,"A payment on this loan is still in progress or has an Unknown result. Resolve it before closing the loan.")
        else:
            loan.status="Closed"; loan.save()
            cancelled=PaymentRequest.objects.filter(instalment__loan=loan,status="Awaiting approval").update(status="Cancelled")
            audit(c["org"],c["actor"],"Loan closed",f"{loan.reference}: {reason}")
            ended=f" {cancelled} open payment request{'s were' if cancelled != 1 else ' was'} cancelled." if cancelled else ""
            messages.success(request,f"{loan.reference} is closed.{ended} All its records are kept.")
    return redirect("customer_detail",pk=loan.customer_id)


def collections(request):
    c=context(request); q=request.GET.get("q",""); filt=request.GET.get("filter","")
    items=Instalment.objects.filter(organisation=c["org"]).select_related("loan__customer").order_by("due_date")
    if q: items=items.filter(Q(loan__customer__name__icontains=q)|Q(loan__reference__icontains=q))
    if filt=="hold": items=items.filter(loan__on_hold=True)
    elif filt in ["failed","confirmed","in-progress"]: items=items.filter(state={"failed":"Failed","confirmed":"Paid","in-progress":"In progress"}[filt])
    elif filt=="upcoming": items=items.filter(due_date__gte=c["today"],paid=0)
    return page(request,"collections",c,instalments=items,q=q,filter=filt)


def payments(request):
    c=context(request); q=request.GET.get("q",""); filt=request.GET.get("filter","")
    items=Payment.objects.filter(organisation=c["org"]).select_related("instalment__loan__customer").order_by("-paid_at")
    reqs=PaymentRequest.objects.filter(organisation=c["org"]).select_related("instalment__loan__customer").order_by("-id")
    if q:
        items=items.filter(Q(reference__icontains=q)|Q(instalment__loan__customer__name__icontains=q))
        reqs=reqs.filter(Q(reference__icontains=q)|Q(instalment__loan__customer__name__icontains=q))
    if filt:
        statuses={"confirmed":"Confirmed","pending":"Awaiting approval","expired":"Expired","cancelled":"Cancelled","failed":"Failed","unknown":"Unknown"}
        status=statuses.get(filt,filt)
        items=items.filter(status=status); reqs=reqs.filter(status=status)
    return page(request,"payments",c,payments=items,requests=reqs,q=q,filter=filt)


def request_form(request):
    c=context(request); permitted(c,["Admin","Preparer"])
    initial={}
    if request.GET.get("instalment"):
        inst=lookup_or_404(Instalment.objects.filter(organisation=c["org"]),request.GET["instalment"])
        initial={"instalment":inst.pk,"amount":Decimal(inst.amount-inst.paid)/100}
    form=RequestForm(request.POST or None,org=c["org"],initial=initial)
    if request.method=="POST" and form.is_valid():
        with transaction.atomic():
            inst=Instalment.objects.select_for_update().get(pk=form.cleaned_data["instalment"].pk,organisation=c["org"])
            loan=Loan.objects.select_for_update().get(pk=inst.loan_id)
            amount=int(form.cleaned_data["amount"]*100)
            open_request=PaymentRequest.objects.filter(instalment=inst,status__in=["Awaiting approval","Awaiting confirmation","Unknown"]).first()
            if not request.POST.get("confirmed"): form.add_error(None,"Tick the box to confirm you have checked the amount and the instalment.")
            elif loan.status!="Open": form.add_error(None,"This loan is closed, so a payment cannot be requested for it.")
            elif loan.on_hold: form.add_error(None,"This loan is on hold, so a payment cannot be requested until the hold is released.")
            elif inst.state in ["Unknown","In progress"]:
                form.add_error(None,"A payment for this instalment is still in progress or has an Unknown result. Wait for the final result before requesting another payment.")
            elif amount>inst.amount-inst.paid: form.add_error("amount",f"Enter an amount no higher than {money(inst.amount-inst.paid)}, the amount outstanding on this instalment.")
            elif open_request:
                form.add_error(None,f"This instalment already has an open payment request ({open_request.reference}, {open_request.status}). Cancel it, or wait until it ends, before creating another.")
            else:
                item=PaymentRequest.objects.create(organisation=c["org"],instalment=inst,amount=amount,reference=f"VP-DEMO-{uuid.uuid4().hex[:16]}",expires_at=timezone.now()+timedelta(hours=form.cleaned_data["expiry_hours"]))
                audit(c["org"],c["actor"],"Payment request created",f"{loan.reference}: {item.reference}, {item.amount_display}")
                messages.success(request,"Payment request created. Copy the payment link below and share it with the customer. In this demo, no payment can be made through it.")
                return redirect("request_detail",pk=item.pk)
    return page(request,"request_form",c,form=form)


def request_detail(request,pk):
    c=context(request); item=get_object_or_404(PaymentRequest.objects.select_related("instalment__loan__customer"),pk=pk,organisation=c["org"])
    return page(request,"request_detail",c,title=f"Payment request {item.reference}",payment_request=item,
                instalment_total=item.instalment.loan.instalments.count(),share_url=request.build_absolute_uri(f"/pay/{item.token}/"))


@require_POST
@transaction.atomic
def cancel_request(request,pk):
    c=context(request); permitted(c,["Admin","Preparer"])
    item=get_object_or_404(PaymentRequest.objects.select_for_update(),pk=pk,organisation=c["org"])
    if item.status=="Awaiting approval":
        item.status="Cancelled"; item.save()
        audit(c["org"],c["actor"],"Payment request cancelled",item.reference)
        messages.success(request,f"Payment request {item.reference} cancelled. Its link no longer works.")
    elif item.status=="Cancelled": messages.error(request,"This payment request is already cancelled.")
    else: messages.error(request,f"This payment request is {item.status}, so it cannot be cancelled. Only requests awaiting the customer's approval can be cancelled.")
    return redirect("payments")


def reviews(request):
    c=context(request); filt=request.GET.get("filter",""); q=request.GET.get("q","")
    items=Review.objects.filter(organisation=c["org"]).select_related("owner","instalment__loan__customer").order_by("deadline")
    # The queue holds open items; closed ones have their own view.
    if filt=="closed": items=items.exclude(status__in=["Open","In progress"])
    else: items=items.filter(status__in=["Open","In progress"])
    if filt=="mine": items=items.filter(owner=c["actor"])
    elif filt=="overdue": items=items.filter(deadline__lt=timezone.now())
    if request.GET.get("type"): items=items.filter(kind=request.GET["type"])
    if q: items=items.filter(Q(instalment__loan__customer__name__icontains=q)|Q(kind__icontains=q))
    return page(request,"reviews",c,reviews=items,q=q,filter=filt)


@transaction.atomic
def review_detail(request,pk):
    c=context(request); item=get_object_or_404(Review.objects.select_for_update(),pk=pk,organisation=c["org"])
    if request.method=="POST":
        action=request.POST.get("action")
        if item.status in ["Resolved","Dismissed"]: messages.error(request,"This review is already closed, so it cannot be changed.")
        elif action=="assign":
            permitted(c,["Admin","Preparer","Reviewer"])
            owner=lookup_or_404(Member.objects.filter(organisation=c["org"]),request.POST.get("owner"))
            # Owners work the item; anyone allowed may still decide it (TRD FR-C5.4, 4.2). Viewers are read-only.
            if owner.role=="Viewer": messages.error(request,"Viewers have read-only access, so they cannot own review items.")
            else:
                item.owner=owner; item.save()
                audit(c["org"],c["actor"],"Review assigned",f"{item.id} → {item.owner.name}")
                messages.success(request,f"{owner.name} now owns this review.")
        elif action=="resolve":
            permitted(c,item.decision_roles); note=request.POST.get("note","").strip(); outcome=request.POST.get("outcome","")
            if item.prepared_by_id==c["actor"].id: messages.error(request,"You prepared this item, so a different person must decide it.")
            elif not note or outcome not in ["Resolved","Dismissed"]: messages.error(request,"Choose an outcome and write a note explaining your decision.")
            elif item.needs_evidence:
                messages.error(request,"This item needs evidence from Paystack or the bank before it can be decided. No Paystack account is connected in this demo, so it stays open.")
            else:
                item.status="Dismissed" if outcome=="Dismissed" else "Resolved"
                item.note=note; item.outcome=outcome; item.resolved_by=c["actor"]; item.save()
                Refund.objects.filter(review=item).update(status="Rejected" if outcome=="Dismissed" else "Approved")
                audit(c["org"],c["actor"],"Review resolved",f"{item.id}: {outcome}. {note}")
                if item.kind=="Refund request":
                    messages.success(request,"Refund rejected. The payment is unchanged." if outcome=="Dismissed" else
                                     "Refund approved. Nothing has been refunded yet: in the live service, Paystack processes approved refunds. In this demo, no money moves.")
                else:
                    messages.success(request,f"Review {'dismissed' if outcome=='Dismissed' else 'resolved'}. Your note is saved with the decision.")
        return redirect("review_detail",pk=pk)
    actor=c["actor"]
    return page(request,"review_detail",c,title=f"{item.kind} · Review",review=item,refund=Refund.objects.filter(review=item).first(),
                owners=[m for m in c["members"] if m.role!="Viewer"],can_decide=actor.role in item.decision_roles and actor.id!=item.prepared_by_id)


def refund_form(request,pk):
    c=context(request); permitted(c,["Admin","Preparer"])
    payment=get_object_or_404(Payment,pk=pk,organisation=c["org"],status="Confirmed")
    reserved=Refund.objects.filter(payment=payment).exclude(status__in=["Rejected","Failed"]).aggregate(s=Sum("amount"))["s"] or 0
    form=RefundForm(request.POST or None,initial={"amount":Decimal(payment.amount-reserved)/100})
    form.fields["amount"].help_text=f"Up to {money(payment.amount-reserved)}: the part of this payment not already covered by refund requests."
    if request.method=="POST" and form.is_valid():
        with transaction.atomic():
            payment=Payment.objects.select_for_update().get(pk=pk)
            amount=int(form.cleaned_data["amount"]*100)
            reserved=Refund.objects.filter(payment=payment).exclude(status__in=["Rejected","Failed"]).aggregate(s=Sum("amount"))["s"] or 0
            if amount>payment.amount-reserved: form.add_error("amount",f"Enter an amount no higher than {money(payment.amount-reserved)}, the part of this payment not already covered by refund requests.")
            else:
                owner=Member.objects.filter(organisation=c["org"],role__in=["Admin","Reviewer"]).exclude(pk=c["actor"].pk).first()
                item=Review.objects.create(organisation=c["org"],instalment=payment.instalment,kind="Refund request",amount=amount,owner=owner,prepared_by=c["actor"],deadline=timezone.now()+timedelta(days=2),evidence=f"Sample payment {payment.reference}. Reason: {form.cleaned_data['reason']}")
                Refund.objects.create(organisation=c["org"],payment=payment,review=item,amount=amount,reason=form.cleaned_data["reason"])
                audit(c["org"],c["actor"],"Refund requested",f"{payment.reference}: {money(amount)}")
                messages.success(request,f"Refund of {money(amount)} requested. A different team member must approve or reject it here in Reviews.")
                return redirect("review_detail",pk=item.pk)
    return page(request,"refund_form",c,form=form,payment=payment)


def reports(request):
    c=context(request)
    return page(request,"reports",c,metrics=metrics(c["org"]))


def settings(request):
    c=context(request)
    form=SettingsForm(request.POST or None,instance=c["org"])
    if c["actor"].role!="Admin":
        for field in form.fields.values(): field.disabled=True
    if request.method=="POST":
        permitted(c,["Admin"])
        if form.is_valid():
            with transaction.atomic():
                form.save(); audit(c["org"],c["actor"],"Settings updated","Organisation name, retry preset or email receipts setting saved.")
            messages.success(request,"Settings saved. Emails and scheduled debits do not run in this demo.")
            return redirect("settings")
    billing={"licence_display":money(15000000),"usage_display":money(0),"bank_display":money(0),"vat_display":money(1125000),"total_display":money(16125000),"eligible_count":0}
    gates=[{"label":text,"done":False} for text in ["Legal clearance received and agreements signed","Hosting and backups set up in Nigeria",
           "At least two team members with two-step verification, so preparer and reviewer can be different people",
           "Paystack live keys connected and a signed webhook event received","Independent security and load tests passed",
           "In Live test mode: a small debit and a Pay-by-bank payment confirmed and matched, and one refunded with a second person's approval",
           "Customer notice dates confirmed, and imported loans checked against your loan system's totals","Team training and pilot acceptance complete"]]
    return page(request,"settings",c,form=form,billing=billing,gate_items=gates,can_edit=c["actor"].role=="Admin")


@require_POST
def demo_role(request):
    c=context(request); member=lookup_or_404(Member.objects.filter(organisation=c["org"]),request.POST.get("member"))
    request.session["actor"]=member.pk
    messages.info(request,f"You're now acting as {member.name} ({member.role}). This is for the demo only; it is not signing in.")
    return redirect("settings")


def preview(request,workspace):
    c=context(request)
    features={"credit":["Ability-to-repay assessments based on bank statements","Separate permissions for reading account data and for the assessment",
                        "A second reviewer records each decision and an explanation for the applicant","No credit scores or automatic approvals: a person always decides"],
              "cash":["Cash balances, each showing when it was last updated","Estimated cash for the next 30 and 90 days, based on expected instalments",
                      "Draft accounting entries checked by a second person, to download as CSV","VAT records, and plans that check whether cash covers payroll (Valo Pay never pays staff)"]}
    name="Credit Desk" if workspace=="credit" else "Cash Desk"
    return page(request,"preview",c,page=workspace,workspace=name,title=name,features=features[workspace])


def public(request,kind,token):
    if kind=="consent":
        loan=get_object_or_404(Loan,consent_token=token)
        expired=loan.consent_status!="Requested" or not loan.consent_requested_at or loan.consent_requested_at+timedelta(days=14)<timezone.now()
        lender=loan.organisation.name
        ctx={"lender":lender,"first_name":loan.customer.name.split()[0],"loan_ref":loan.reference,
             "instalments":loan.instalments.filter(paid__lt=F("amount"),due_date__gte=timezone.localdate()).order_by("sequence"),"max_display":loan.consent_max_display,"expiry":loan.consent_expiry,
             "retry_text":content.RETRY_FOR_CUSTOMER.get(loan.organisation.retry_preset,"").format(lender=lender)}
    else:
        item=get_object_or_404(PaymentRequest.objects.select_related("instalment__loan__customer","organisation"),token=token)
        expired=item.status in ["Expired","Cancelled"] or item.expires_at<timezone.now()
        ctx={"lender":item.organisation.name,"first_name":item.customer_name.split()[0],"loan_ref":item.instalment.loan.reference,"amount_display":item.amount_display,
             "expiry":item.expires_at,"instalment":item.instalment,"instalment_total":item.instalment.loan.instalments.count()}
    if request.method=="POST" and not expired:
        # The hand-off page: truthful in the demo, since no provider is connected and nothing was authorised or paid.
        kind="confirmation"
    return render(request,"public.html",{**ctx,"flow":"consent" if "retry_text" in ctx else "payment","kind":"expired" if expired else kind,"token":token})


def exports(request,kind):
    c=context(request); org=c["org"]
    if kind=="audit": permitted(c,["Admin"])
    response=HttpResponse(content_type="text/csv; charset=utf-8")
    response["Content-Disposition"]=f'attachment; filename="valo-{kind}.csv"'
    response.write("\ufeff")
    writer=csv.writer(response)
    def row(values):
        # Prevent spreadsheet formula injection from user-controlled values.
        writer.writerow(["'"+v if isinstance(v,str) and v.startswith(("=","+","-","@","\t","\r")) else v for v in values])
    if kind=="template":
        row(["customer_id","name","email","phone","loan_id","product","amount","due_date"])
        row(["CUS-2001","Sample Customer","sample@example.com","","LN-3001","Personal finance","35000.00",str(c["today"]+timedelta(days=30))])
    elif kind=="payments":
        row(["reference","customer","amount_ngn","status","source","paid_at","sample_data"])
        for p in Payment.objects.filter(organisation=org): row([p.reference,p.customer_name,f"{Decimal(p.amount)/100:.2f}",p.status,p.source,p.paid_at.isoformat(),True])
    elif kind=="consents":
        row(["loan","customer","status","maximum_ngn","expiry"])
        for l in Loan.objects.filter(organisation=org): row([l.reference,l.customer.name,l.consent_status,f"{Decimal(l.consent_max)/100:.2f}",l.consent_expiry])
    elif kind=="reviews":
        row(["id","type","customer","status","owner","deadline","outcome","note","prepared_by","decided_by"])
        for r in Review.objects.filter(organisation=org).select_related("owner","prepared_by","resolved_by","instalment__loan__customer"):
            row([r.pk,r.kind,r.customer_name,r.status,r.owner.name,r.deadline.isoformat(),r.outcome,r.note,r.prepared_by.name,r.resolved_by.name if r.resolved_by else ""])
    elif kind=="audit":
        row(["time","actor","action","detail","previous_hash","hash"])
        for a in Audit.objects.filter(organisation=org): row([a.created_at.isoformat(),a.actor_name,a.action,a.detail,a.previous_hash,a.digest])
    elif kind=="customer":
        customer=lookup_or_404(Customer.objects.filter(organisation=org),request.GET.get("customer"))
        row(["loan","sequence","due_date","amount_ngn","paid_ngn","status"])
        for i in Instalment.objects.filter(organisation=org,loan__customer=customer): row([i.loan.reference,i.sequence,i.due_date,f"{Decimal(i.amount)/100:.2f}",f"{Decimal(i.paid)/100:.2f}",i.status])
    elif kind=="daily":
        m=metrics(org); day=lambda d: f"{d.day} {d:%b %Y}"; today=day(c["today"]); month=f"{day(m['month_start'])} to {today} (WAT)"
        row(["metric","value","period","data"])
        for label,value,period in [("Instalments due today and not yet paid",m["due_count"],today),
                                   ("Outstanding on instalments due today (NGN)",f"{Decimal(m['due_kobo'])/100:.2f}",today),
                                   ("Confirmed payments",m["confirmed_count"],month),("Confirmed payments (NGN)",f"{Decimal(m['collected_kobo'])/100:.2f}",month),
                                   ("Failed instalments",m["failed_count"],"Now"),("Open reviews",m["review_count"],"Now"),
                                   ("Instalments on hold",m["held_count"],"Now"),("Loans with active consent",m["active_consents"],"Now"),("Customers",m["customer_count"],"Now")]:
            row([label,value,period,"Sample data from the demo"])
    else:
        raise Http404("No such export.")
    return response