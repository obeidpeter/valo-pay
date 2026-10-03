import csv
import uuid
from datetime import timedelta
from decimal import Decimal
from django.contrib import messages
from django.core.exceptions import PermissionDenied
from django.db import transaction, IntegrityError
from django.db.models import Q, Sum
from django.http import HttpResponse
from django.shortcuts import render, redirect, get_object_or_404
from django.utils import timezone
from django.views.decorators.http import require_POST
from .models import *
from .forms import CustomerForm, RequestForm, RefundForm, SettingsForm
from .services import context, audit, month_date, validate_csv, commit_csv


def permitted(ctx, roles):
    if ctx["actor"].role not in roles:
        raise PermissionDenied("This simulated role is not permitted to perform this action.")


def page(request, template, ctx, **extra):
    ctx.update(extra)
    ctx.setdefault("page", template)
    ctx.setdefault("title", {"today":"Today", "payments":"Pay-by-bank", "customer_detail":"Customer", "request_detail":"Payment request"}.get(template, template.replace("_"," ").title()))
    return render(request, template+".html", ctx)


def metrics(org):
    due = Instalment.objects.filter(organisation=org, due_date=timezone.localdate())
    payments = Payment.objects.filter(organisation=org, status="Confirmed", paid_at__gte=timezone.now().replace(day=1,hour=0,minute=0,second=0))
    return {"due_display":money(sum(i.amount-i.paid for i in due)), "due_count":due.exclude(state="Paid").count(),
            "collected_display":money(payments.aggregate(s=Sum("amount"))["s"] or 0), "confirmed_count":payments.count(),
            "failed_count":Instalment.objects.filter(organisation=org,state="Failed").count(),
            "review_count":Review.objects.filter(organisation=org,status__in=["Open","In progress"]).count(),
            "held_count":Instalment.objects.filter(organisation=org,loan__on_hold=True).exclude(state="Paid").count(),
            "active_consents":Loan.objects.filter(organisation=org,consent_status="Active").count(),
            "customer_count":Customer.objects.filter(organisation=org).count()}


def home(request):
    c = context(request); org = c["org"]
    return page(request,"today",c,metrics=metrics(org),
                recent_payments=Payment.objects.filter(organisation=org).select_related("instalment__loan__customer").order_by("-paid_at")[:6],
                urgent_reviews=Review.objects.filter(organisation=org,status__in=["Open","In progress"]).select_related("owner","instalment__loan__customer").order_by("deadline")[:4],
                instalments=Instalment.objects.filter(organisation=org,due_date=c["today"]).select_related("loan__customer"),
                activity=Audit.objects.filter(organisation=org)[:5])


def customers(request):
    c=context(request); q=request.GET.get("q","").strip(); filt=request.GET.get("filter","")
    items=Customer.objects.filter(organisation=c["org"]).prefetch_related("loans__instalments").order_by("name")
    if q:
        items=items.filter(Q(name__icontains=q)|Q(email__icontains=q)|Q(phone__icontains=q)|Q(external_id__icontains=q)|Q(loans__reference__icontains=q)).distinct()
    if filt=="hold": items=items.filter(loans__on_hold=True)
    if filt=="no-consent": items=items.exclude(loans__consent_status="Active")
    if filt=="overdue": items=items.filter(loans__instalments__due_date__lt=c["today"],loans__instalments__paid=0).distinct()
    return page(request,"customers",c,customers=items,q=q,filter=filt)


def customer_detail(request,pk):
    c=context(request); customer=get_object_or_404(Customer,pk=pk,organisation=c["org"])
    loan=customer.loans.first()
    return page(request,"customer_detail",c,customer=customer,loan=loan,
                instalments=loan.instalments.all().order_by("sequence"),
                payments=Payment.objects.filter(organisation=c["org"],instalment__loan=loan),
                reviews=Review.objects.filter(organisation=c["org"],instalment__loan=loan),
                activity=Audit.objects.filter(organisation=c["org"],detail__contains=loan.reference))


def customer_form(request,pk=None):
    c=context(request); permitted(c,["Admin","Preparer"])
    customer=get_object_or_404(Customer,pk=pk,organisation=c["org"]) if pk else None
    initial={}
    if customer:
        loan=customer.loans.first(); inst=loan.instalments.first()
        initial={"name":customer.name,"external_id":customer.external_id,"email":customer.email,"phone":customer.phone,
                 "loan_id":loan.reference,"product":loan.product,"amount":Decimal(inst.amount)/100,"due_date":inst.due_date,"instalment_count":loan.instalments.count()}
    form=CustomerForm(request.POST or None,initial=initial)
    if customer:
        for f in ["loan_id","amount","due_date","instalment_count"]:
            form.fields[f].disabled=True
            form.fields[f].help_text="Schedule changes require versioning and renewed notice; not available in this sandbox release."
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
            messages.success(request,"Customer saved.")
            return redirect("customer_detail",pk=customer.pk)
        except IntegrityError:
            form.add_error(None,"Customer or loan ID already exists in this organisation.")
    return page(request,"customer_form",c,form=form,customer=customer)


def import_customers(request):
    c=context(request); permitted(c,["Admin","Preparer"])
    text=request.POST.get("csv_data","")
    errors=[]; rows=[]
    if request.method=="POST":
        errors,rows=validate_csv(text,c["org"])
        if request.POST.get("action")=="commit" and not errors:
            try:
                commit_csv(rows,c["org"],c["actor"])
                messages.success(request,f"Imported {len(rows)} instalments.")
                return redirect("customers")
            except IntegrityError:
                errors=["This import conflicts with records already saved. Nothing was imported."]
    return page(request,"import",c,csv_data=text,errors=errors,preview=rows[:50],validated=bool(rows) and not errors)


@require_POST
@transaction.atomic
def loan_action(request,pk):
    c=context(request); action=request.POST.get("action"); reason=request.POST.get("reason","").strip()
    loan=get_object_or_404(Loan.objects.select_for_update(),pk=pk,organisation=c["org"])
    if action=="release": permitted(c,["Admin","Reviewer"])
    elif action=="hold": permitted(c,["Admin","Preparer","Reviewer"])
    else: permitted(c,["Admin","Preparer"])
    if action!="consent" and not reason:
        messages.error(request,"A reason is required.")
    elif action=="consent":
        if loan.status!="Open": messages.error(request,"Closed loans cannot receive consent requests.")
        elif loan.consent_status in ["Active","Awaiting bank"]: messages.error(request,"An active or pending consent already exists.")
        else:
            loan.consent_status="Requested"; loan.consent_requested_at=timezone.now(); loan.consent_token=token(); loan.save()
            audit(c["org"],c["actor"],"Consent link created",loan.reference)
            messages.success(request,"Demo consent link created. No email was sent and no bank authorisation has been created.")
    elif action=="hold":
        if not loan.on_hold:
            loan.on_hold=True; loan.hold_reason=reason; loan.held_by=c["actor"]; loan.save()
            audit(c["org"],c["actor"],"Loan held",f"{loan.reference}: {reason}")
    elif action=="release":
        if loan.held_by_id==c["actor"].id:
            messages.error(request,"A different Reviewer must release this hold.")
        elif loan.instalments.filter(state="Unknown").exists():
            messages.error(request,"Unknown results require final provider evidence. This hold cannot be released.")
        else:
            loan.on_hold=False; loan.hold_reason=""; loan.save()
            audit(c["org"],c["actor"],"Hold released",f"{loan.reference}: {reason}")
    elif action=="withdraw":
        if loan.consent_status in ["Active","Awaiting bank"]:
            messages.error(request,"Provider deactivation is unavailable. No withdrawal has been claimed; live processing is disabled.")
        else:
            loan.consent_status="Withdrawn"; loan.save()
            audit(c["org"],c["actor"],"Unused consent link withdrawn",f"{loan.reference}: {reason}")
    elif action=="close":
        if PaymentRequest.objects.filter(instalment__loan=loan,status__in=["Awaiting confirmation","Unknown"]).exists():
            messages.error(request,"Resolve in-progress money states before closing this loan.")
        else:
            loan.status="Closed"; loan.save()
            PaymentRequest.objects.filter(instalment__loan=loan,status="Awaiting approval").update(status="Cancelled")
            audit(c["org"],c["actor"],"Loan closed",f"{loan.reference}: {reason}")
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
    if request.GET.get("instalment","").isdigit():
        inst=get_object_or_404(Instalment,pk=request.GET["instalment"],organisation=c["org"])
        initial={"instalment":inst.pk,"amount":Decimal(inst.amount-inst.paid)/100}
    form=RequestForm(request.POST or None,org=c["org"],initial=initial)
    if request.method=="POST" and form.is_valid():
        with transaction.atomic():
            inst=Instalment.objects.select_for_update().get(pk=form.cleaned_data["instalment"].pk,organisation=c["org"])
            loan=Loan.objects.select_for_update().get(pk=inst.loan_id)
            amount=int(form.cleaned_data["amount"]*100)
            if not request.POST.get("confirmed"): form.add_error(None,"Confirm the amount and recipient before creating a request.")
            elif loan.on_hold or loan.status!="Open" or inst.state in ["Unknown","In progress"]:
                form.add_error(None,"This instalment is on hold, closed, or already in progress.")
            elif amount>inst.amount-inst.paid: form.add_error("amount","Cannot exceed the outstanding amount.")
            elif PaymentRequest.objects.filter(instalment=inst,status__in=["Awaiting approval","Awaiting confirmation","Unknown"]).exists():
                form.add_error(None,"A request is already in progress for this instalment.")
            else:
                item=PaymentRequest.objects.create(organisation=c["org"],instalment=inst,amount=amount,reference=f"VP-DEMO-{uuid.uuid4().hex[:16]}",expires_at=timezone.now()+timedelta(hours=form.cleaned_data["expiry_hours"]))
                audit(c["org"],c["actor"],"Payment request created",f"{loan.reference}: {item.reference}, {item.amount_display}")
                messages.success(request,"Demo payment link created. No payment provider is connected.")
                return redirect("request_detail",pk=item.pk)
    return page(request,"request_form",c,form=form)


def request_detail(request,pk):
    c=context(request); item=get_object_or_404(PaymentRequest,pk=pk,organisation=c["org"])
    return page(request,"request_detail",c,payment_request=item,share_url=request.build_absolute_uri(f"/pay/{item.token}/"))


@require_POST
@transaction.atomic
def cancel_request(request,pk):
    c=context(request); permitted(c,["Admin","Preparer"])
    item=get_object_or_404(PaymentRequest.objects.select_for_update(),pk=pk,organisation=c["org"])
    if item.status=="Awaiting approval":
        item.status="Cancelled"; item.save()
        audit(c["org"],c["actor"],"Payment request cancelled",item.reference)
        messages.success(request,"Request cancelled.")
    else: messages.error(request,"Only an unpaid request awaiting approval can be cancelled.")
    return redirect("payments")


def reviews(request):
    c=context(request); filt=request.GET.get("filter",""); q=request.GET.get("q","")
    items=Review.objects.filter(organisation=c["org"]).select_related("owner","instalment__loan__customer").order_by("deadline")
    if filt=="mine": items=items.filter(owner=c["actor"])
    elif filt=="overdue": items=items.filter(deadline__lt=timezone.now(),status__in=["Open","In progress"])
    if request.GET.get("type"): items=items.filter(kind=request.GET["type"])
    if q: items=items.filter(Q(instalment__loan__customer__name__icontains=q)|Q(kind__icontains=q))
    return page(request,"reviews",c,reviews=items,q=q,filter=filt)


@transaction.atomic
def review_detail(request,pk):
    c=context(request); item=get_object_or_404(Review.objects.select_for_update(),pk=pk,organisation=c["org"])
    if request.method=="POST":
        action=request.POST.get("action")
        if action=="assign":
            permitted(c,["Admin","Preparer","Reviewer"])
            item.owner=get_object_or_404(Member,pk=request.POST.get("owner"),organisation=c["org"]); item.save()
            audit(c["org"],c["actor"],"Review assigned",f"{item.id} → {item.owner.name}")
            messages.success(request,"Owner updated.")
        elif action=="resolve":
            permitted(c,["Admin","Reviewer"]); note=request.POST.get("note","").strip(); outcome=request.POST.get("outcome","")
            if item.status in ["Resolved","Dismissed"]: messages.error(request,"This review is already closed.")
            elif item.prepared_by_id==c["actor"].id: messages.error(request,"A different person must review this item.")
            elif not note or outcome not in ["Resolved","Dismissed","Failed"]: messages.error(request,"Select an outcome and add a note.")
            elif item.kind in ["Unknown result","Unclear match","Possible duplicate","Reversal"]:
                messages.error(request,"Provider or bank evidence is required. Financial resolution is disabled until the integration is connected.")
            else:
                item.status="Dismissed" if outcome=="Dismissed" else "Resolved"
                item.note=note; item.outcome=outcome; item.resolved_by=c["actor"]; item.save()
                Refund.objects.filter(review=item).update(status="Rejected" if outcome=="Dismissed" else "Approved")
                audit(c["org"],c["actor"],"Review resolved",f"{item.id}: {outcome}. {note}")
                messages.success(request,"Decision saved. Approved refunds remain unprocessed until a provider is connected.")
        return redirect("review_detail",pk=pk)
    return page(request,"review_detail",c,review=item)


def refund_form(request,pk):
    c=context(request); permitted(c,["Admin","Preparer"])
    payment=get_object_or_404(Payment,pk=pk,organisation=c["org"],status="Confirmed")
    form=RefundForm(request.POST or None,initial={"amount":Decimal(payment.amount)/100})
    if request.method=="POST" and form.is_valid():
        with transaction.atomic():
            payment=Payment.objects.select_for_update().get(pk=pk)
            amount=int(form.cleaned_data["amount"]*100)
            reserved=Refund.objects.filter(payment=payment).exclude(status__in=["Rejected","Failed"]).aggregate(s=Sum("amount"))["s"] or 0
            if amount>payment.amount-reserved: form.add_error("amount","Exceeds the amount still available to refund.")
            else:
                owner=Member.objects.filter(organisation=c["org"],role__in=["Admin","Reviewer"]).exclude(pk=c["actor"].pk).first()
                item=Review.objects.create(organisation=c["org"],instalment=payment.instalment,kind="Refund request",amount=amount,owner=owner,prepared_by=c["actor"],deadline=timezone.now()+timedelta(days=2),evidence=f"Sample payment {payment.reference}. Reason: {form.cleaned_data['reason']}")
                Refund.objects.create(organisation=c["org"],payment=payment,review=item,amount=amount,reason=form.cleaned_data["reason"])
                audit(c["org"],c["actor"],"Refund requested",f"{payment.reference}: {money(amount)}")
                return redirect("review_detail",pk=item.pk)
    return page(request,"refund_form",c,form=form,payment=payment)


def reports(request):
    c=context(request)
    return page(request,"reports",c,metrics=metrics(c["org"]))


def settings(request):
    c=context(request)
    form=SettingsForm(request.POST or None,instance=c["org"])
    if request.method=="POST":
        permitted(c,["Admin"])
        if form.is_valid():
            with transaction.atomic():
                form.save(); audit(c["org"],c["actor"],"Settings updated","Organisation name, retry preset or receipt preference updated in demo.")
            messages.success(request,"Demo settings saved. Email delivery and scheduled debits are not connected.")
            return redirect("settings")
    billing={"licence_display":money(15000000),"usage_display":money(0),"bank_display":money(0),"vat_display":money(1125000),"total_display":money(16125000),"eligible_count":0}
    gates=[{"label":text,"done":False} for text in ["Legal clearance and signed agreements","Nigerian production hosting and backups","Two verified staff accounts with two-step verification","Paystack connection and signed webhook verified","Independent security and load testing","Live-test debit, payment and second-approved refund","Customer notice dates and reconciled import","Pilot training and acceptance"]]
    return page(request,"settings",c,form=form,billing=billing,gate_items=gates)


@require_POST
def demo_role(request):
    c=context(request); member=get_object_or_404(Member,pk=request.POST.get("member"),organisation=c["org"])
    request.session["actor"]=member.pk
    messages.info(request,f"Simulating {member.name} ({member.role}). This is not authentication.")
    return redirect("settings")


def preview(request,workspace):
    c=context(request)
    features={"credit":["Statement-based ability-to-repay assessments","Separate data-access and assessment permissions","Second-person review with applicant explanations","No credit scores or automated approvals"],
              "cash":["Cash balances with freshness dates","30- and 90-day collection forecasts","Reviewed accounting drafts and CSV exports","VAT records and payroll funding plans — no payouts"]}
    return page(request,"preview",c,page=workspace,workspace="Credit Desk" if workspace=="credit" else "Cash Desk",features=features[workspace])


def public(request,kind,token):
    if kind=="consent":
        loan=get_object_or_404(Loan,consent_token=token)
        expired=loan.consent_status!="Requested" or not loan.consent_requested_at or loan.consent_requested_at+timedelta(days=14)<timezone.now()
        ctx={"lender":loan.organisation.name,"first_name":loan.customer.name.split()[0],"loan_ref":loan.reference,
             "instalments":loan.instalments.all(),"max_display":loan.consent_max_display,"expiry":loan.consent_expiry,"retry_preset":loan.organisation.retry_preset}
    else:
        item=get_object_or_404(PaymentRequest,token=token)
        expired=item.status in ["Expired","Cancelled"] or item.expires_at<timezone.now()
        ctx={"lender":item.organisation.name,"first_name":item.customer_name.split()[0],"loan_ref":item.instalment.loan.reference,"amount_display":item.amount_display,"expiry":item.expires_at}
    if request.method=="POST" and not expired:
        messages.error(request,"Bank authorisation is unavailable in this demo. No bank was contacted and no payment was made.")
    return render(request,"public.html",{**ctx,"kind":"expired" if expired else kind,"token":token})


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
        row(["reference","customer","amount_ngn","status","source","paid_at","synthetic"])
        for p in Payment.objects.filter(organisation=org): row([p.reference,p.customer_name,f"{Decimal(p.amount)/100:.2f}",p.status,p.source,p.paid_at.isoformat(),True])
    elif kind=="consents":
        row(["loan","customer","status","maximum_ngn","expiry"])
        for l in Loan.objects.filter(organisation=org): row([l.reference,l.customer.name,l.consent_status,f"{Decimal(l.consent_max)/100:.2f}",l.consent_expiry])
    elif kind=="reviews":
        row(["id","type","customer","status","owner","deadline","outcome","note"])
        for r in Review.objects.filter(organisation=org): row([r.pk,r.kind,r.customer_name,r.status,r.owner.name,r.deadline.isoformat(),r.outcome,r.note])
    elif kind=="audit":
        row(["time","actor","action","detail","previous_hash","hash"])
        for a in Audit.objects.filter(organisation=org): row([a.created_at.isoformat(),a.actor_name,a.action,a.detail,a.previous_hash,a.digest])
    elif kind=="customer":
        customer=get_object_or_404(Customer,organisation=org,pk=request.GET.get("customer"))
        row(["loan","sequence","due_date","amount_ngn","paid_ngn","status"])
        for i in Instalment.objects.filter(organisation=org,loan__customer=customer): row([i.loan.reference,i.sequence,i.due_date,f"{Decimal(i.amount)/100:.2f}",f"{Decimal(i.paid)/100:.2f}",i.status])
    elif kind=="daily":
        row(["metric","value","dataset"])
        for key,value in metrics(org).items(): row([key,value,"Synthetic demo only"])
    else:
        return HttpResponse("Unknown export",status=404)
    return response