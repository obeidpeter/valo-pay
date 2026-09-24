import { useState } from "react";
import { Link } from "wouter";
import { useWorkspace } from "@/lib/workspace-context";
import { usePilotMutation, usePilotQuery } from "@/lib/pilot";
import { staffDirectorySchema, type StaffDirectory } from "@workspace/valopay-schema";
import {
  PilotError,
  PilotHeading,
  PilotPanel,
  RecoveryNotice,
  pilotField,
} from "@/components/pilot-ui";
import { StaffSession } from "@/components/staff-session";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useDialogFocusReturn } from "@/lib/focus";
import { formatCount, formatDate } from "@/lib/formatters";
import { AccessReadiness } from '@/components/access-readiness';

const roles = [
  "Admin",
  "Operations",
  "Finance",
  "Compliance reviewer",
  "Read-only",
];
export default function TeamPage() {
  const { workspace } = useWorkspace(),
    query = usePilotQuery("/team", staffDirectorySchema, false);
  const [email, setEmail] = useState(""),
    [role, setRole] = useState("Operations"),
    [link, setLink] = useState(""),
    [message, setMessage] = useState("");
  const invite = usePilotMutation((result) => {
    setLink(
      `${window.location.origin}${import.meta.env.BASE_URL}team-invite#${result.token}`,
    );
    setMessage(result.message);
    setEmail("");
  });
  const revoke = usePilotMutation((result) => setMessage(result.message));
  const [decision, setDecision] = useState("");
  const decide = usePilotMutation((result) => setDecision(result.message));
  // The directory as the shared schema read it: every list present, lenders included.
  const directory = query.data;
  const admin = directory?.mode === "staff" && workspace?.role === "Admin";
  return (
    <div className="space-y-6">
      <PilotHeading title="Team & access">
        Give each person an accountable role. Staff invitations, role changes
        and revocations are recorded separately from financial approvals.
      </PilotHeading>
      <PilotError
        error={query.error}
        retry={() => {
          void query.refetch();
        }}
      />
      <PilotPanel title="Access status">
        <p className="text-sm">
          {directory?.message || "Checking this environment…"}
        </p>
        {directory?.mode === "staff" ? (
          <StaffSession />
        ) : (
          <p className="text-sm text-muted-foreground">
            This environment uses demo personas. Pilot staff mode requires a
            configured organisation, an administrator provisioned by the
            operator, and MFA. Sample records remain synthetic in either mode.
          </p>
        )}
      </PilotPanel>
      {directory?.mode === "staff" && (
        <>
          {workspace?.role !== "Admin" && !workspace?.merchants.length && <PilotPanel title="Waiting for lender access"><p className="text-sm text-muted-foreground">Your staff account is active. An administrator must assign the lenders you may work on before their records appear here.</p></PilotPanel>}
          <PilotPanel title="Staff members">
            <p className="text-sm text-muted-foreground">Administrators manage every lender in this workspace. Other roles need explicit lender access. New invitations and role changes start with no lender grants.</p>
            <div className="space-y-3">
              {directory.members.map((member: any) => (
                <Member
                  key={`${member.id}:${member.updatedAt}`}
                  member={member}
                  editable={admin && member.actor !== workspace?.actor}
                  lenders={directory.lenders}
                />
              ))}
            </div>
          </PilotPanel>
          {admin && (
            <Approvals directory={directory} actor={workspace?.actor} decide={decide} message={decision} />
          )}
          {admin && (
            <PilotPanel title="Invite a team member">
              <p className="text-sm text-muted-foreground">
                First add the person to this organisation in your identity
                service. Their Valo Pay invitation requires the same verified
                email and both authentication factors. Invitations last seven
                days; accepted pilot membership lasts 90 days.
                After acceptance, assign the lenders a non-administrator may access.
                An Admin, Finance or Compliance reviewer invitation can be accepted
                only after another administrator approves it.
              </p>
              <form
                className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_auto]"
                onSubmit={(e) => {
                  e.preventDefault();
                  setLink("");
                  invite.mutate({
                    path: "/team/invitations",
                    lender: false,
                    data: { email, role },
                  });
                }}
              >
                <label className="space-y-1 text-sm font-medium">
                  Verified email
                  <input
                    className={pilotField}
                    type="email"
                    required
                    maxLength={254}
                    disabled={invite.isPending || invite.hasUnconfirmedOutcome}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </label>
                <label className="space-y-1 text-sm font-medium">
                  Role
                  <select
                    className={pilotField}
                    disabled={invite.isPending || invite.hasUnconfirmedOutcome}
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                  >
                    {roles.map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </label>
                <Button
                  type="submit"
                  disabled={invite.hasUnconfirmedOutcome}
                  busy={invite.isPending}
                >
                  Create invitation
                </Button>
              </form>
              <RecoveryNotice mutation={invite} persistent={false} />
              {link && (
                <label className="block space-y-2 text-sm">
                  Share this invitation directly
                  <input
                    readOnly
                    className={pilotField}
                    value={link}
                    onFocus={(e) => e.target.select()}
                  />
                </label>
              )}
              <p role="status" className="text-sm">
                {message}
              </p>
              <div className="space-y-3">
                {directory.invitations.map((item: any) => (
                  <div
                    key={item.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm"
                  >
                    <span>
                      {item.email} · {item.role}
                      <small className="mt-1 block text-muted-foreground">
                        {item.status}{item.status === "pending" && item.approval === "awaiting" ? " · waiting for a second administrator" : item.approval === "approved" ? ` · approved by ${item.approvedBy}` : ""} · expires {formatDate(item.expiresAt)}
                      </small>
                    </span>
                    {item.status === "pending" && (
                      <Button
                        variant="outline"
                        disabled={revoke.hasUnconfirmedOutcome}
                        busy={revoke.isPending}
                        onClick={() =>
                          revoke.mutate({
                            path: `/team/invitations/${item.id}/revoke`,
                            lender: false,
                          })
                        }
                      >
                        Revoke invitation
                      </Button>
                    )}
                  </div>
                ))}
              </div>
              <RecoveryNotice mutation={revoke} persistent={false} />
            </PilotPanel>
          )}
          {admin && (
            <PilotPanel title="Access history">
              <ol className="space-y-3 text-sm">
                {directory.events.map((event: any) => (
                  <li key={event.id} className="border-b pb-3">
                    <strong>{event.action.replaceAll(".", " ")}</strong>
                    <p className="text-xs text-muted-foreground">
                      {event.actor} · {formatDate(event.createdAt)}
                    </p>
                    {event.detail.reason && (
                      <p className="mt-1">{event.detail.reason}</p>
                    )}
                  </li>
                ))}
              </ol>
            </PilotPanel>
          )}
        </>
      )}
      <AccessReadiness />
      <Link
        href="/pilot"
        className="inline-block text-sm text-primary underline"
      >
        Return to the pilot journey
      </Link>
    </div>
  );
}
function Member({ member, editable, lenders }: { member: any; editable: boolean; lenders: any[] }) {
  const [role, setRole] = useState(member.role),
    [status, setStatus] = useState(member.status),
    [reason, setReason] = useState(""),
    // Revoking cannot be undone here, so it takes one more step after its reason; other changes save at once.
    [confirming, setConfirming] = useState(false);
  const mutation = usePilotMutation();
  const restoreFocus = useDialogFocusReturn(confirming);
  const save = () =>
    mutation.mutate({
      path: `/team/members/${member.id}`,
      method: "PATCH",
      lender: false,
      data: {
        role,
        status,
        reason,
        expectedUpdatedAt: member.updatedAt,
      },
    });
  return (
    <article className="space-y-3 rounded-lg border p-4">
      <div>
        <h3 className="text-sm font-semibold">{member.name}</h3>
        <p className="text-xs text-muted-foreground">
          {member.role} · {member.status}
          {member.expiresAt ? ` · expires ${formatDate(member.expiresAt)}` : ""}
        </p>
      </div>
      <p className="text-sm text-muted-foreground">{member.role === "Admin" ? "All lenders in this workspace" : formatCount(member.lenderIds?.length || 0, "permitted lender")}</p>
      {editable && (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (status === "revoked" && member.status !== "revoked") setConfirming(true);
            else save();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm">
              Role for {member.name}
              <select
                className={pilotField}
                disabled={mutation.isPending || mutation.hasUnconfirmedOutcome}
                value={role}
                onChange={(e) => setRole(e.target.value)}
              >
                {roles.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-sm">
              Access for {member.name}
              <select
                className={pilotField}
                disabled={mutation.isPending || mutation.hasUnconfirmedOutcome}
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                {["active", "suspended", "revoked"].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="block space-y-1 text-sm">
            Reason for changing {member.name}
            <input
              className={pilotField}
              required
              minLength={3}
              maxLength={500}
              disabled={mutation.isPending || mutation.hasUnconfirmedOutcome}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <Button
            variant={status === "revoked" ? "destructive" : "outline"}
            type="submit"
            disabled={mutation.hasUnconfirmedOutcome}
            busy={mutation.isPending}
          >
            Save access change
          </Button>
          <RecoveryNotice mutation={mutation} persistent={false} />
          {mutation.data?.message && <p role="status" className="text-sm">{mutation.data.message}</p>}
        </form>
      )}
      <Dialog open={confirming} onOpenChange={(open) => { if (!open) setConfirming(false); }}>
        <DialogContent onCloseAutoFocus={restoreFocus}>
          <DialogHeader>
            <DialogTitle>Revoke {member.name}’s access?</DialogTitle>
            <DialogDescription>
              {member.name} loses access to this workspace and to every lender in it at their next request. Their lender access and any invitation still waiting for them are removed.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <p>A revoked person regains access only by accepting a new invitation.</p>
            <p>Reason recorded in the access history: {reason}</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>Keep access</Button>
            <Button variant="destructive" onClick={() => { setConfirming(false); save(); }}>Revoke access</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {editable && member.role !== "Admin" && member.status === "active" && <LenderGrants key={member.updatedAt} member={member} lenders={lenders} />}
    </article>
  );
}

/**
 * What waits for a second administrator: Admin, Finance and Compliance reviewer invitations and role changes. The
 * administrator who asked cannot approve (the service refuses it too), but may withdraw a change.
 */
function Approvals({ directory, actor, decide, message }: { directory: StaffDirectory; actor?: string; decide: ReturnType<typeof usePilotMutation>; message: string }) {
  const invitations = directory.invitations.filter((item) => item.status === "pending" && item.approval === "awaiting");
  const busy = decide.isPending || decide.hasUnconfirmedOutcome;
  return (
    <PilotPanel title="Waiting for a second administrator">
      <p className="text-sm text-muted-foreground">
        An invitation or role change that grants Admin, Finance or Compliance reviewer takes effect only when an
        administrator other than the one who asked approves it. A pilot with one administrator asks the operator to
        add a second with the provisioning command.
      </p>
      {!invitations.length && !directory.changes.length ? <p className="text-sm">Nothing is waiting for approval.</p> : (
        <ul className="space-y-3">
          {invitations.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm">
              <span>Invitation: {item.email} as {item.role}<small className="mt-1 block text-muted-foreground">Sent by {item.invitedBy} · expires {formatDate(item.expiresAt)}</small></span>
              {item.invitedBy === actor ? <span className="text-xs text-muted-foreground">You sent it: another administrator approves it.</span> : (
                <Button variant="outline" disabled={busy} onClick={() => decide.mutate({ path: `/team/invitations/${item.id}/approve`, lender: false })}>Approve invitation</Button>
              )}
            </li>
          ))}
          {directory.changes.map((change) => (
            <li key={change.id} className="space-y-2 rounded-lg border p-3 text-sm">
              <p>{change.name}: {change.from.role} ({change.from.status}) to {change.to.role} ({change.to.status})</p>
              <p className="text-xs text-muted-foreground">Asked by {change.requestedBy} · {formatDate(change.requestedAt)} · {change.reason}</p>
              <div className="flex flex-wrap gap-2">
                {change.requestedBy === actor ? <span className="self-center text-xs text-muted-foreground">You asked for it: another administrator approves it.</span> : (
                  <Button variant="outline" disabled={busy} onClick={() => decide.mutate({ path: `/team/changes/${change.id}/approve`, lender: false })}>Approve change</Button>
                )}
                <Button variant="ghost" disabled={busy} onClick={() => decide.mutate({ path: `/team/changes/${change.id}/decline`, lender: false })}>{change.requestedBy === actor ? "Withdraw request" : "Decline change"}</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <RecoveryNotice mutation={decide} persistent={false} />
      {message && <p role="status" className="text-sm">{message}</p>}
    </PilotPanel>
  );
}

function LenderGrants({ member, lenders }: { member: any; lenders: any[] }) {
  const [selected, setSelected] = useState<string[]>(member.lenderIds || []), [reason, setReason] = useState("");
  const mutation = usePilotMutation(() => setReason("")), busy = mutation.isPending || mutation.hasUnconfirmedOutcome;
  return <form className="space-y-3 border-t pt-4" onSubmit={event => { event.preventDefault(); mutation.mutate({ path: `/team/members/${member.id}/lenders`, lender: false, method: "PATCH", data: { expectedUpdatedAt: member.updatedAt, lenderIds: selected, reason } }); }}>
    <fieldset disabled={busy} className="space-y-2"><legend className="mb-2 text-sm font-semibold">Lenders available to {member.name}</legend>{lenders.length ? lenders.map(lender => <label key={lender.id} className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={selected.includes(lender.id)} onChange={event => setSelected(current => event.target.checked ? [...current, lender.id] : current.filter(id => id !== lender.id))} />{lender.name}</label>) : <p className="text-sm text-muted-foreground">Create a lender from the pilot journey before assigning access.</p>}
      <label className="block space-y-1 text-sm">Reason for lender access change for {member.name}<textarea className={pilotField} required minLength={10} maxLength={1000} rows={2} value={reason} onChange={event => setReason(event.target.value)} /></label>
      <p className="text-xs text-muted-foreground">Clearing every selection removes lender access. Saved sessions are checked again on the next request.</p>
      <Button type="submit" variant="outline" busy={mutation.isPending}>Save lender access</Button>
    </fieldset><RecoveryNotice mutation={mutation} persistent={false} />{mutation.isSuccess && <p role="status" className="text-sm">Lender access saved.</p>}
  </form>;
}
