import { Button } from "./ui/button";

/** Said before a person discards a request whose outcome is unknown: it may have been saved, and it is not cancelled. */
export const DISCARD_ORIGINAL_WARNING =
  "The original request may already have been saved. Discarding it here does not cancel it, and a new submission will not be recognised as a repeat. Check Operations or the records before you submit again. Discard the original request?";

/**
 * The way out of an unconfirmed request that cannot be recovered: after the
 * warning, the console forgets the original and its key, and the form is free
 * again. Retrying the original stays the first choice on every recovery notice.
 */
export function DiscardOriginalRequest({
  onDiscard,
  disabled,
}: {
  onDiscard(): void;
  disabled?: boolean;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={disabled}
      onClick={() => {
        if (window.confirm(DISCARD_ORIGINAL_WARNING)) onDiscard();
      }}
    >
      Discard original request
    </Button>
  );
}
