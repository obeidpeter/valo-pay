import { useState } from "react";
import { Link } from "wouter";
import { useWorkspace } from "@/lib/workspace-context";
import { usePilotMutation, usePilotQuery } from "@/lib/pilot";
import {
  PilotError,
  PilotHeading,
  PilotPanel,
  RecoveryNotice,
  pilotField,
} from "@/components/pilot-ui";
import { StaffSession } from "@/components/staff-session";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/formatters";

const roles = [
  "Admin",
  "Operations",
  "Finance",
  "Compliance reviewer",
  "Read-only",
];
export default function TeamPage() {
  const { workspace } = useWorkspace(),
    query = usePilotQuery("/team", false);
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
  const admin = query.data?.mode === "staff" && workspace?.role === "Admin";
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
          {query.data?.message || "Checking this environment…"}
        </p>
        {query.data?.mode === "staff" ? (
          <StaffSession />
        ) : (
          <p className="text-sm text-muted-foreground">
            This environment uses demo personas. Pilot staff mode requires a
            configured organisation, an administrator provisioned by the
            operator, and MFA. Sample records remain synthetic in either mode.
          </p>
        )}
      </PilotPanel>
      {query.data?.mode === "staff" && (
        <>
          <PilotPanel title="Staff members">
            <div className="space-y-3">
              {query.data.members.map((member: any) => (
                <Member
                  key={`${member.id}:${member.updatedAt}`}
                  member={member}
                  editable={admin && member.actor !== workspace?.actor}
                />
              ))}
            </div>
          </PilotPanel>
          {admin && (
            <PilotPanel title="Invite a team member">
              <p className="text-sm text-muted-foreground">
                First add the person to this organisation in your identity
                service. Their Valo Pay invitation requires the same verified
                email and both authentication factors. Invitations last seven
                days; accepted pilot membership lasts 90 days.
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
                {query.data.invitations.map((item: any) => (
                  <div
                    key={item.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm"
                  >
                    <span>
                      {item.email} · {item.role}
                      <small className="mt-1 block text-muted-foreground">
                        {item.status} · expires {formatDate(item.expiresAt)}
                      </small>
                    </span>
                    {item.status === "pending" && (
                      <Button
                        variant="outline"
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
              <PilotError error={revoke.error} />
            </PilotPanel>
          )}
          {admin && (
            <PilotPanel title="Access history">
              <ol className="space-y-3 text-sm">
                {query.data.events.map((event: any) => (
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
      <Link
        href="/pilot"
        className="inline-block text-sm text-primary underline"
      >
        Return to the pilot journey
      </Link>
    </div>
  );
}
function Member({ member, editable }: { member: any; editable: boolean }) {
  const [role, setRole] = useState(member.role),
    [status, setStatus] = useState(member.status),
    [reason, setReason] = useState("");
  const mutation = usePilotMutation();
  return (
    <article className="space-y-3 rounded-lg border p-4">
      <div>
        <h3 className="text-sm font-semibold">{member.name}</h3>
        <p className="text-xs text-muted-foreground">
          {member.role} · {member.status} · expires{" "}
          {formatDate(member.expiresAt)}
        </p>
      </div>
      {editable && (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
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
        </form>
      )}
    </article>
  );
}
