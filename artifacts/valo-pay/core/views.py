import csv
import uuid
from datetime import timedelta
from decimal import Decimal
from django.contrib import messages
from django.core.exceptions import PermissionDenied
from django.db import transaction, IntegrityError
from django.db.models import Q, Sum
from django.http import HttpResponse, Http404
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
    ctx.setdefault("title", {"today":"Dashboard", "payments":"Pay-by-bank", "customer_detail":"Customer", "request_detail":"Payment request"}.get(template, template.replace("_"," ").title()))
    return render(request, template+".html", ctx)


def metrics(org):
    due = Instalment.objects.filter(organisation=org, due_date=timezone.localdate())
    review_instalments = Review.objects.filter(organisation=org, status__in=["Open", "In progress"]).values("instalment_id")
    payments = Payment.objects.filter(organisation=org, status="Confirmed", paid_at__gte=timezone.localtime().replace(day=1,hour=0,minute=0,second=0,microsecond=0)).exclude(instalment_id__in=review_instalments).exclude(instalment__state__in=["Unknown", "In progress"])
    return {"due_display":money(sum(i.amount-i.paid for i in due)), "due_count":due.exclude(state="Paid").count(),
            "collected_display":money(payments.aggregate(s=Sum("amount"))["s"] or 0), "confirmed_count":payments.count(),
            "failed_count":Instalment.objects.filter(organisation=org,state="Failed").count(),
            "review_count":Review.objects.filter(organisation=org,status__in=["Open","In progress"]).count(),
            "held_count":Instalment.objects.filter(organisation=org,loan__on_hold=True).exclude(state="Paid").count(),
            "held_loans":Instalment.objects.filter(organisation=org,loan__on_hold=True).exclude(state="Paid").values("loan_id").distinct().count(),
            "active_consents":Loan.objects.filter(organisation=org,consent_status="Active").count(),
            "customer_count":Customer.objects.filter(organisation=org).count()}


def home(request):
    c = context(request); org = c["org"]
    from .demo_flow import available
    from .demo_debits import outlook
    due = Instalment.objects.filter(organisation=org,due_date=c["today"]).select_related("loan__customer")
    demo_rows = outlook(org, due) if available(request) else None
    return page(request,"today",c,metrics=metrics(org),
                demo_due_rows=demo_rows,
                can_run_demo=bool(demo_rows and c["can_prepare"] and any(state=="ready" for _,state,_ in demo_rows)
                                  and not Payment.objects.filter(organisation=org,sample=False).exists()),
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
    from django.core.paginator import Paginator
    pager=Paginator(items.distinct(),50).get_page(request.GET.get("page",1))
    return page(request,"customers",c,customers=pager.object_list,page_obj=pager,q=q,filter=filt)


def customer_detail(request,pk):
    from django.core.paginator import Paginator
    c=context(request); customer=get_object_or_404(Customer,pk=pk,organisation=c["org"])
    def paginate(items, size, parameter):
        return Paginator(items, size).get_page(request.GET.get(parameter, 1))
    loans = paginate(customer.loans.order_by("pk"), 5, "loans_page")
    for item in loans:
        item.schedule_parameter = f"schedule_{item.pk}"
        item.schedule_page = paginate(item.instalments.order_by("sequence", "pk"), 20, item.schedule_parameter)
    return page(request,"customer_detail",c,customer=customer,
                loans=loans,
                payments=paginate(Payment.objects.filter(organisation=c["org"],instalment__loan__customer=customer).order_by("-paid_at", "-pk"), 25, "payments_page"),
                reviews=paginate(Review.objects.filter(organisation=c["org"],instalment__loan__customer=customer).order_by("-pk"), 25, "reviews_page"),
                activity=paginate(Audit.objects.filter(organisation=c["org"],customer_ids__contains=[str(customer.pk)]).order_by("-created_at", "-pk"), 25, "history_page"))


def customer_form(request,pk=None):
    c=context(request); permitted(c,["Admin","Preparer"])
    customer=get_object_or_404(Customer,pk=pk,organisation=c["org"]) if pk else None
    initial={}
    if customer:
        selected_loan=request.GET.get("loan")
        if selected_loan:
            if not selected_loan.isascii() or not selected_loan.isdigit() or len(selected_loan)>18:
                raise Http404
            loan=get_object_or_404(Loan,pk=selected_loan,customer=customer,organisation=c["org"])
        else:
            loan=customer.loans.first()
        initial={"name":customer.name,"external_id":customer.external_id,"email":customer.email,"phone":customer.phone}
        if loan:
            initial["product"]=loan.product
    form=CustomerForm(request.POST or None,initial=initial)
    if customer:
        from django import forms as django_forms
        form.fields["change_reason"]=django_forms.CharField(label="Reason for correction",max_length=1500,required=True)
        for f in ["loan_id","amount","due_date","instalment_count"]:
            form.fields.pop(f)
        if not loan:
            form.fields.pop("product")
    if request.method=="POST" and form.is_valid():
        d=form.cleaned_data
        try:
            with transaction.atomic():
                Organisation.objects.select_for_update().get(pk=c["org"].pk)
                if customer:
                    for key in ["name","external_id","email","phone"]: setattr(customer,key,d[key])
                    customer.save()
                    if loan:
                        loan.product=d["product"]; loan.save(update_fields=["product"])
                else:
                    customer=Customer.objects.create(organisation=c["org"],**{k:d[k] for k in ["name","external_id","email","phone"]})
                    amount=int(d["amount"]*100)
                    loan=Loan.objects.create(organisation=c["org"],customer=customer,reference=d["loan_id"],product=d["product"],consent_max=amount,consent_expiry=month_date(d["due_date"],d["instalment_count"]-1)+timedelta(days=30))
                    for n in range(d["instalment_count"]):
                        Instalment.objects.create(organisation=c["org"],loan=loan,sequence=n+1,due_date=month_date(d["due_date"],n),amount=amount)
                audit(c["org"],c["actor"],"Customer updated" if pk else "Customer created",loan.reference if loan else customer.external_id,
                    subject=customer,before=initial,after=d,reason=request.POST.get("change_reason","Created customer" if not pk else "Staff record correction"))
            messages.success(request,"Customer saved.")
            return redirect("customer_detail",pk=customer.pk)
        except IntegrityError:
            form.add_error(None,"Customer or loan ID already exists in this organisation.")
    return page(request,"customer_form",c,form=form,customer=customer)


def import_customers(request):
    import hashlib
    from django.utils.crypto import salted_hmac
    c=context(request); permitted(c,["Admin","Preparer"])
    text=request.POST.get("csv_data","")
    errors=[]; rows=[]; receipt=None
    if request.method=="POST":
        errors,rows=validate_csv(text,c["org"])
        if not request.session.session_key:
            request.session.save()
        session_digest=salted_hmac("import-session",request.session.session_key).hexdigest()
        content_digest=hashlib.sha256(text.encode()).hexdigest()
        if request.POST.get("action")=="validate" and not errors:
            receipt=ImportPreview.objects.create(organisation=c["org"],session_digest=session_digest,
                content_digest=content_digest,row_count=len(rows),expires_at=timezone.now()+timedelta(minutes=15))
        elif request.POST.get("action")=="commit" and not errors:
            try:
                with transaction.atomic():
                    Organisation.objects.select_for_update().get(pk=c["org"].pk)
                    if request.user.is_authenticated:
                        get_object_or_404(StaffMembership.objects.select_for_update(),user=request.user,organisation=c["org"],active=True,role__in=["Admin","Preparer"])
                    else:
                        get_object_or_404(Member.objects.select_for_update(),pk=c["actor"].pk,organisation=c["org"],role__in=["Admin","Preparer"],user__isnull=True)
                    try:
                        receipt=ImportPreview.objects.select_for_update().filter(pk=uuid.UUID(request.POST.get("preview_id","")),
                            organisation=c["org"],session_digest=session_digest,content_digest=content_digest,
                            expires_at__gt=timezone.now(),consumed_at__isnull=True,row_count=len(rows)).first()
                    except ValueError:
                        receipt=None
                    if receipt is None:
                        raise ValueError("Validate this exact file again. The preview is missing, changed, expired, from another session, or already used. Nothing was imported.")
                    conflicts,_=validate_csv(text,c["org"])
                    if conflicts:
                        raise ValueError("; ".join(conflicts))
                    commit_csv(rows,c["org"],c["actor"])
                    receipt.consumed_at=timezone.now()
                    receipt.save(update_fields=["consumed_at"])
                messages.success(request,f"Imported {len(rows)} instalments.")
                return redirect("customers")
            except IntegrityError:
                errors=["This import conflicts with records already saved. Nothing was imported."]
            except ValueError as exc:
                errors=[str(exc)]
    return page(request,"import",c,csv_data=text,errors=errors,preview=rows[:50],total_rows=len(rows),
                preview_id=receipt.pk if receipt else "",validated=bool(receipt) and not errors)


@require_POST
@transaction.atomic
def loan_action(request,pk):
    c=context(request); action=request.POST.get("action"); reason=request.POST.get("reason","").strip()
    loan=get_object_or_404(Loan.objects.select_for_update(),pk=pk,organisation=c["org"])
    before={"status":loan.status,"on_hold":loan.on_hold,"consent_status":loan.consent_status,"hold_reason":loan.hold_reason}
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
            audit(c["org"],c["actor"],"Consent link created",loan.reference,subject=loan,before=before,after={"consent_status":loan.consent_status},reason="Local consent request")
            messages.success(request,"Demo consent link created. No email was sent and no bank authorisation has been created.")
    elif action=="hold":
        if loan.status != "Open":
            messages.error(request,"This loan is closed, so it cannot be put on hold.")
        elif not loan.on_hold:
            loan.on_hold=True; loan.hold_reason=reason; loan.held_by=c["actor"]; loan.save()
            audit(c["org"],c["actor"],"Loan held",f"{loan.reference}: {reason}",subject=loan,before=before,after={"on_hold":True,"hold_reason":reason},reason=reason)
    elif action=="release":
        if loan.held_by_id==c["actor"].id:
            messages.error(request,"A different Reviewer must release this hold.")
        elif loan.instalments.filter(state="Unknown").exists():
            messages.error(request,"Unknown results require final provider evidence. This hold cannot be released.")
        else:
            loan.on_hold=False; loan.hold_reason=""; loan.save()
            audit(c["org"],c["actor"],"Hold released",f"{loan.reference}: {reason}",subject=loan,before=before,after={"on_hold":False},reason=reason)
    elif action=="withdraw":
        if loan.consent_status in ["Active","Awaiting bank"]:
            messages.error(request,"Provider deactivation is unavailable. No withdrawal has been claimed; live processing is disabled.")
        elif loan.consent_status != "Requested":
            messages.error(request,"There is no unused consent link to withdraw.")
        else:
            loan.consent_status="Withdrawn"; loan.save()
            audit(c["org"],c["actor"],"Unused consent link withdrawn",f"{loan.reference}: {reason}",subject=loan,before=before,after={"consent_status":"Withdrawn"},reason=reason)
    elif action=="close":
        if loan.status == "Closed":
            messages.error(request,"This loan is already closed.")
        elif loan.instalments.filter(state__in=["Unknown","In progress"]).exists() or PaymentRequest.objects.filter(instalment__loan=loan,status__in=["Awaiting confirmation","Unknown"]).exists():
            messages.error(request,"Resolve in-progress money states before closing this loan.")
        else:
            loan.status="Closed"; loan.save()
            for pending_request in PaymentRequest.objects.select_for_update().filter(instalment__loan=loan,status="Awaiting approval").order_by("pk"):
                pending_request.status="Cancelled";pending_request.save(update_fields=["status"])
                audit(c["org"],c["actor"],"Payment request cancelled",pending_request.reference,subject=pending_request,
                    before={"status":"Awaiting approval"},after={"status":"Cancelled"},reason="Loan closed: "+reason)
            audit(c["org"],c["actor"],"Loan closed",f"{loan.reference}: {reason}",subject=loan,before=before,after={"status":"Closed"},reason=reason)
    return redirect("customer_detail",pk=loan.customer_id)


def collections(request):
    c=context(request); q=request.GET.get("q",""); filt=request.GET.get("filter","")
    items=Instalment.objects.filter(organisation=c["org"]).select_related("loan__customer").order_by("due_date")
    if q: items=items.filter(Q(loan__customer__name__icontains=q)|Q(loan__reference__icontains=q))
    if filt=="hold": items=items.filter(loan__on_hold=True)
    elif filt in ["failed","confirmed","in-progress","unknown"]: items=items.filter(state={"failed":"Failed","confirmed":"Paid","in-progress":"In progress","unknown":"Unknown"}[filt])
    elif filt=="upcoming": items=items.filter(due_date__gte=c["today"],paid=0)
    from django.core.paginator import Paginator
    totals=items.aggregate(amount=Sum("amount"),paid=Sum("paid"))
    pager=Paginator(items.order_by("due_date","pk"),50).get_page(request.GET.get("page",1))
    return page(request,"collections",c,instalments=pager.object_list,page_obj=pager,q=q,filter=filt,
        dataset_amount=money(totals["amount"] or 0),dataset_paid=money(totals["paid"] or 0),
        dataset_outstanding=money((totals["amount"] or 0)-(totals["paid"] or 0)))


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
    from django.core.paginator import Paginator
    payment_page=Paginator(items.order_by("-paid_at","-pk"),50).get_page(request.GET.get("records_page",1))
    request_page=Paginator(reqs,50).get_page(request.GET.get("requests_page",1))
    return page(request,"payments",c,payments=payment_page.object_list,requests=request_page.object_list,
                payment_page=payment_page,request_page=request_page,q=q,filter=filt)


def request_form(request):
    c=context(request); permitted(c,["Admin","Preparer"])
    initial={}
    if request.GET.get("instalment") and (not request.GET["instalment"].isascii() or not request.GET["instalment"].isdigit()):
        raise Http404
    if request.GET.get("instalment","").isdigit():
        inst=get_object_or_404(Instalment,pk=request.GET["instalment"],organisation=c["org"])
        initial={"instalment":inst.pk,"amount":Decimal(inst.amount-inst.paid)/100}
    form=RequestForm(request.POST or None,org=c["org"],initial=initial)
    # Bounded selector; Collections exposes every eligible record through search/pages.
    choice_ids=list(form.fields["instalment"].queryset.order_by("due_date","pk").values_list("pk",flat=True)[:50])
    selected=request.POST.get("instalment") or initial.get("instalment")
    if str(selected).isascii() and str(selected).isdigit():
        choice_ids.append(int(selected))
    form.fields["instalment"].queryset=form.fields["instalment"].queryset.filter(pk__in=choice_ids)
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
                audit(c["org"],c["actor"],"Payment request created",f"{loan.reference}: {item.reference}, {item.amount_display}",
                    subject=item,after={"status":item.status,"amount":item.amount},reason="Confirmed request record")
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
        audit(c["org"],c["actor"],"Payment request cancelled",item.reference,subject=item,
            before={"status":"Awaiting approval"},after={"status":"Cancelled"},reason="Staff cancellation")
        messages.success(request,"Request cancelled.")
    else: messages.error(request,"Only an unpaid request awaiting approval can be cancelled.")
    return redirect("payments")


def reviews(request):
    c=context(request); filt=request.GET.get("filter",""); q=request.GET.get("q","")
    items=Review.objects.filter(organisation=c["org"]).select_related("owner","instalment__loan__customer").order_by("deadline")
    if filt == "closed":
        items=items.exclude(status__in=["Open","In progress"])
    else:
        items=items.filter(status__in=["Open","In progress"])
    if filt=="mine": items=items.filter(owner=c["actor"])
    elif filt=="overdue": items=items.filter(deadline__lt=timezone.now(),status__in=["Open","In progress"])
    if request.GET.get("type"): items=items.filter(kind=request.GET["type"])
    if q: items=items.filter(Q(instalment__loan__customer__name__icontains=q)|Q(kind__icontains=q))
    from django.core.paginator import Paginator
    pager=Paginator(items.order_by("deadline","pk"),50).get_page(request.GET.get("page",1))
    return page(request,"reviews",c,reviews=pager.object_list,page_obj=pager,q=q,filter=filt)


@transaction.atomic
def review_detail(request,pk):
    c=context(request); item=get_object_or_404(Review.objects.select_for_update(),pk=pk,organisation=c["org"])
    before={"status":item.status,"owner_id":item.owner_id,"outcome":item.outcome,"note":item.note}
    if request.user.is_authenticated and item.kind in ("Refund request", "Refund after withdrawal"):
        refund=get_object_or_404(Refund,review=item,organisation=c["org"])
        return redirect(f"/access/refunds/{refund.pk}/")
    if request.method=="POST":
        action=request.POST.get("action")
        if action=="assign":
            permitted(c,["Admin","Preparer","Reviewer"])
            if item.status not in ("Open","In progress"):
                raise PermissionDenied("Closed reviews cannot be reassigned.")
            item.owner=get_object_or_404(Member,pk=request.POST.get("owner"),organisation=c["org"],id__in=[m.id for m in c["members"] if m.role != "Viewer"]); item.save()
            audit(c["org"],c["actor"],"Review assigned",f"{item.id} → {item.owner.name}",subject=item,
                before=before,after={"owner_id":item.owner_id},reason="Staff reassignment")
            messages.success(request,"Owner updated.")
        elif action=="resolve":
            permitted(c,["Admin","Reviewer"]); note=request.POST.get("note","").strip(); outcome=request.POST.get("outcome","")
            if item.status in ["Resolved","Dismissed"]: messages.error(request,"This review is already closed.")
            elif item.prepared_by_id==c["actor"].id: messages.error(request,"A different person must review this item.")
            elif not note or outcome not in ["Resolved","Dismissed"]: messages.error(request,"Select a valid decision and add a note.")
            elif item.kind in ["Unknown result","Unclear match","Possible duplicate","Reversal"]:
                messages.error(request,"Provider or bank evidence is required. Financial resolution is disabled until the integration is connected.")
            else:
                if item.kind in ("Refund request", "Refund after withdrawal"):
                    refund = get_object_or_404(Refund.objects.select_for_update(), review=item, organisation=c["org"])
                    payment = get_object_or_404(Payment.objects.select_for_update(), pk=refund.payment_id, organisation=c["org"])
                    if (refund.status != "Requested" or payment.status != "Confirmed"
                            or payment.instalment_id != item.instalment_id):
                        messages.error(request, "The payment or refund changed. No decision was saved.")
                        return redirect("review_detail", pk=pk)
                    reserved = Refund.objects.filter(payment=payment).exclude(status__in=["Rejected","Failed"]).aggregate(s=Sum("amount"))["s"] or 0
                    if reserved > payment.amount:
                        messages.error(request, "Refund reservations exceed the confirmed payment. Investigate before deciding.")
                        return redirect("review_detail", pk=pk)
                item.status="Dismissed" if outcome=="Dismissed" else "Resolved"
                item.note=note; item.outcome=outcome; item.resolved_by=c["actor"]; item.save()
                Refund.objects.filter(review=item).update(status="Rejected" if outcome=="Dismissed" else "Approved")
                audit(c["org"],c["actor"],"Review resolved",f"{item.id}: {outcome}. {note}",subject=item,
                    before=before,after={"status":item.status,"outcome":item.outcome,"note":note},reason=note)
                messages.success(request,"Decision saved. Approved refunds remain unprocessed until a provider is connected.")
        return redirect("review_detail",pk=pk)
    c["members"]=[m for m in c["members"] if m.role != "Viewer"]
    return page(request,"review_detail",c,review=item)


def refund_form(request,pk):
    c=context(request); permitted(c,["Admin","Preparer"])
    payment=get_object_or_404(Payment,pk=pk,organisation=c["org"],status="Confirmed")
    form=RefundForm(request.POST or None,initial={"amount":Decimal(payment.amount)/100})
    from .business_days import review_deadline, CalendarUnavailable, calendar_notice
    deadline = basis = None
    deadline_notice = calendar_notice(synthetic=not request.user.is_authenticated)
    try:
        deadline, basis = review_deadline("Refund request", synthetic=not request.user.is_authenticated)
    except CalendarUnavailable as exc:
        if request.method == "POST":
            form.add_error(None, str(exc))
    if request.method=="POST" and form.is_valid():
        with transaction.atomic():
            payment=Payment.objects.select_for_update().get(pk=pk)
            if (payment.organisation_id!=c["org"].pk or payment.status!="Confirmed"
                    or payment.instalment.organisation_id!=c["org"].pk
                    or payment.instalment.loan.organisation_id!=c["org"].pk):
                raise PermissionDenied("Payment state or tenant changed.")
            amount=int(form.cleaned_data["amount"]*100)
            reserved=Refund.objects.filter(payment=payment).exclude(status__in=["Rejected","Failed"]).aggregate(s=Sum("amount"))["s"] or 0
            duplicate=Refund.objects.filter(payment=payment,organisation=c["org"],amount=amount,
                reason=form.cleaned_data["reason"],review__prepared_by=c["actor"]).exclude(status__in=["Rejected","Failed"]).first()
            if duplicate:
                messages.info(request,"This matching refund request already exists. No duplicate was created.")
                return redirect("review_detail",pk=duplicate.review_id)
            if amount>payment.amount-reserved: form.add_error("amount","Exceeds the amount still available to refund.")
            else:
                owner=next((m for m in c["members"] if m.role in ["Admin","Reviewer"] and m.pk!=c["actor"].pk),None)
                if owner is None:
                    form.add_error(None, "A separate reviewer is required. Add an eligible reviewer before requesting a refund.")
                    return page(request,"refund_form",c,form=form,payment=payment,deadline_available=deadline is not None,deadline_notice=deadline_notice)
                item=Review.objects.create(organisation=c["org"],instalment=payment.instalment,kind="Refund request",amount=amount,owner=owner,prepared_by=c["actor"],deadline=deadline,deadline_basis=basis,evidence=f"Payment record {payment.reference}. Reason: {form.cleaned_data['reason']}")
                Refund.objects.create(organisation=c["org"],payment=payment,review=item,amount=amount,reason=form.cleaned_data["reason"])
                audit(c["org"],c["actor"],"Refund requested",f"{payment.reference}: {money(amount)}",
                     subject=item,after={"amount":amount,"status":"Requested","deadline":deadline,"deadline_basis":basis},reason=form.cleaned_data["reason"])
                return redirect("review_detail",pk=item.pk)
    return page(request,"refund_form",c,form=form,payment=payment,deadline_available=deadline is not None,deadline_notice=deadline_notice)


def reports(request):
    c=context(request)
    return page(request,"reports",c,metrics=metrics(c["org"]))


def settings(request):
    c=context(request)
    before={"name":c["org"].name,"retry_preset":c["org"].retry_preset,"receipts":c["org"].receipts}
    form=SettingsForm(request.POST or None,instance=c["org"])
    if request.method=="POST":
        permitted(c,["Admin"])
        if form.is_valid():
            with transaction.atomic():
                form.save(); audit(c["org"],c["actor"],"Settings updated","Organisation name, retry preset or receipt preference updated in preview.",
                    subject=c["org"],before=before,after=form.cleaned_data,reason="Admin saved organisation defaults")
            messages.success(request,"Demo settings saved. Email delivery and scheduled debits are not connected.")
            return redirect("settings")
    billing={"licence_display":money(15000000),"usage_display":money(0),"bank_display":money(0),"vat_display":money(1125000),"total_display":money(16125000),"eligible_count":0}
    gates=[{"label":text,"done":False} for text in ["Legal clearance and signed agreements","Nigerian production hosting and backups","Two verified staff accounts with two-step verification","Paystack connection and signed webhook verified","Independent security and load testing","Live-test debit, payment and second-approved refund","Customer notice dates and reconciled import","Pilot training and acceptance"]]
    from .business_days import calendar_notice
    return page(request,"settings",c,form=form,billing=billing,gate_items=gates,calendar_notice=calendar_notice(synthetic=not request.user.is_authenticated))


@require_POST
def demo_role(request):
    if request.user.is_authenticated:
        raise PermissionDenied("Verified staff cannot switch simulated roles.")
    c=context(request); member=get_object_or_404(Member,pk=request.POST.get("member"),organisation=c["org"])
    request.session["actor"]=member.pk
    messages.info(request,f"Simulating {member.name} ({member.role}). This is not authentication.")
    return redirect("settings")


def preview(request,workspace):
    if request.user.is_authenticated:
        raise PermissionDenied("Future-workspace demos are separate from staff organisations.")
    c=context(request)
    features={"credit":["Statement-based ability-to-repay assessments","Separate data-access and assessment permissions","Second-person review with applicant explanations","No credit scores or automated approvals"],
              "cash":["Cash balances with freshness dates","30- and 90-day collection forecasts","Reviewed accounting drafts and CSV exports","VAT records and payroll funding plans — no payouts"]}
    return page(request,"preview",c,page=workspace,workspace="Credit Desk" if workspace=="credit" else "Cash Desk",features=features[workspace])


def public(request,kind,token):
    from django.core.paginator import Paginator
    from .borrower_states import consent_state, payment_state
    if kind=="consent":
        loan=get_object_or_404(Loan,consent_token=token)
        expired=loan.consent_status!="Requested" or not loan.consent_requested_at or loan.consent_requested_at+timedelta(days=14)<timezone.now()
        ctx={"lender":loan.organisation.name,"first_name":loan.customer.name.split()[0],"loan_ref":loan.reference,
             "instalments":Paginator(loan.instalments.order_by("sequence", "pk"), 20).get_page(request.GET.get("page", 1)),"max_display":loan.consent_max_display,"expiry":loan.consent_expiry,"retry_preset":loan.organisation.retry_preset}
        ctx.update(consent_state(loan))
    else:
        item=get_object_or_404(PaymentRequest,token=token)
        expired=item.status in ["Expired","Cancelled"] or item.expires_at<timezone.now()
        ctx={"lender":item.organisation.name,"first_name":item.customer_name.split()[0],"loan_ref":item.instalment.loan.reference,"amount_display":item.amount_display,"expiry":item.expires_at}
        ctx.update(payment_state(item))
    if request.method=="POST":
        messages.info(request,"The latest stored state is shown. This submission did not initiate an authorisation or payment; no provider was contacted.")
    return render(request,"public.html",{**ctx,"kind":kind,"token":token})


def exports(request,kind):
    c=context(request); org=c["org"]
    if kind in ("schedule","customer"):
        raw=request.GET.get("customer","")
        if not raw.isascii() or not raw.isdigit():
            raise Http404
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
        for p in Payment.objects.filter(organisation=org): row([p.reference,p.customer_name,f"{Decimal(p.amount)/100:.2f}",p.status,p.source,p.paid_at.isoformat() if p.paid_at else "",p.sample])
    elif kind=="consents":
        row(["loan","customer","status","maximum_ngn","expiry"])
        for l in Loan.objects.filter(organisation=org): row([l.reference,l.customer.name,l.consent_status,f"{Decimal(l.consent_max)/100:.2f}",l.consent_expiry])
    elif kind=="reviews":
        row(["id","type","customer","status","owner","deadline","outcome","note"])
        for r in Review.objects.filter(organisation=org): row([r.pk,r.kind,r.customer_name,r.status,r.owner.name if r.owner else "",r.deadline.isoformat(),r.outcome,r.note])
    elif kind=="audit":
        import json
        row(["time","actor","action","detail","previous_hash","hash","schema_version","actor_user_id","entity_type","entity_id","customer_ids","before","after","reason"])
        for a in Audit.objects.filter(organisation=org): row([a.created_at.isoformat(),a.actor_name,a.action,a.detail,a.previous_hash,a.digest,
            a.schema_version,a.actor_user_id,a.entity_type,a.entity_id,json.dumps(a.customer_ids),json.dumps(a.before_state),json.dumps(a.after_state),a.reason])
    elif kind=="customer":
        import json
        customer=get_object_or_404(Customer,organisation=org,pk=request.GET.get("customer"))
        row(["time_utc","actor","actor_user_id","action","entity_type","entity_id","before","after","reason","detail"])
        for event in Audit.objects.filter(organisation=org,customer_ids__contains=[str(customer.pk)]).order_by("created_at","pk"):
            row([event.created_at.isoformat(),event.actor_name,event.actor_user_id,event.action,event.entity_type,event.entity_id,
                 json.dumps(event.before_state,ensure_ascii=False),json.dumps(event.after_state,ensure_ascii=False),event.reason,event.detail])
    elif kind=="schedule":
        customer=get_object_or_404(Customer,organisation=org,pk=request.GET.get("customer"))
        row(["loan","sequence","due_date","amount_ngn","paid_ngn","status"])
        for i in Instalment.objects.filter(organisation=org,loan__customer=customer): row([i.loan.reference,i.sequence,i.due_date,f"{Decimal(i.amount)/100:.2f}",f"{Decimal(i.paid)/100:.2f}",i.status])
    elif kind=="daily":
        row(["metric","value","dataset"])
        for key,value in metrics(org).items(): row([key,value,"Synthetic demo only"])
    else:
        return HttpResponse("Unknown export",status=404)
    return response