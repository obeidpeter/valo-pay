import { clientNetwork, createWindowCounter, type WindowCounter } from "./request-limits";

/**
 * New anonymous sandboxes seed two lenders each, so their creation is bounded
 * on top of the request limit: per client network (an IPv4 address, or an
 * IPv6 /64, which one subscriber can fill with new addresses), per IPv6 /48 (a
 * site's usual allocation, 65,536 /64s), and per process, which bounds what a
 * client with many networks can start. In-memory, per process: see
 * request-limits.ts.
 */
export const WORKSPACE_CREATION_LIMIT = 20;
/** New sandboxes an hour from one IPv6 /48, whichever /64s they come from. */
export const WORKSPACE_CREATION_SITE_LIMIT = 60;
/** New anonymous sandboxes an hour on one API process, from everyone. */
export const WORKSPACE_CREATION_INSTANCE_LIMIT = 300;
/** The window: one hour. */
export const WORKSPACE_CREATION_WINDOW_MS = 60 * 60 * 1000;
/** The seconds a refused creation is told to wait (Retry-After): the whole window, as its message says ("in an hour"). */
export const WORKSPACE_CREATION_RETRY_AFTER_SECONDS = WORKSPACE_CREATION_WINDOW_MS / 1000;

/** A fixed-window counter of creations per key. */
export type CreationLimiter = WindowCounter;
export function createCreationLimiter(limit = WORKSPACE_CREATION_LIMIT, windowMs = WORKSPACE_CREATION_WINDOW_MS): CreationLimiter {
  return createWindowCounter({ limit, windowMs, maxKeys: 20_000 });
}

/** Why a new sandbox was refused: its network's (or /48's) hourly share is used, or this process's. */
export type CreationRefusal = "network" | "instance";
/** The three limits together: a creation takes a slot of each, or of none when any is full. */
export function createSandboxCreationLimits(limits: { network: number; site: number; instance: number } = { network: WORKSPACE_CREATION_LIMIT, site: WORKSPACE_CREATION_SITE_LIMIT, instance: WORKSPACE_CREATION_INSTANCE_LIMIT }, windowMs = WORKSPACE_CREATION_WINDOW_MS) {
  const networks = createCreationLimiter(limits.network, windowMs), sites = createCreationLimiter(limits.site, windowMs), instance = createCreationLimiter(limits.instance, windowMs);
  return {
    /** Takes a creation for a client address; returns why not, taking nothing, when a limit is full. */
    take(address: string | undefined, nowMs = Date.now()): CreationRefusal | undefined {
      const network = clientNetwork(address), site = clientNetwork(address, 48);
      if (!networks.remaining(network, nowMs) || !sites.remaining(site, nowMs)) return "network";
      if (!instance.remaining("instance", nowMs)) return "instance";
      networks.take(network, nowMs); sites.take(site, nowMs); instance.take("instance", nowMs);
      return undefined;
    },
  };
}
/** The message a refused creation answers with (429). */
export function creationRefusalMessage(refusal: CreationRefusal): string {
  return refusal === "instance"
    ? "Too many new sandboxes have been started on this server in the last hour; please try again in an hour."
    : "Too many new sandboxes from your network; please try again in an hour.";
}
