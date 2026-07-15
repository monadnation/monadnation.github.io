// Reusable modal overlay for the end-of-page CTA buttons. One overlay,
// one content slot — each button's data-modal attribute picks which panel
// from #modal-content-store gets moved into it, rather than four separate
// overlay structures.
//
// Single source of truth: openModal(id)/closeModal() below are the only
// two functions that touch overlay/body/scroll-lock state, and every
// trigger (buttons, ✕, backdrop, Escape) calls one of the two — so there's
// exactly one place that can leave things inconsistent, not four.
//
// TODO: these are same-page overlays, not real navigation. If any of these
// ever need a shareable URL or back-button support, convert them to real
// routes instead of extending this.

function initModals() {
  const overlay = document.getElementById("modal-overlay");
  const card = document.getElementById("modal-card");
  const body = document.getElementById("modal-body");
  const closeButton = document.getElementById("modal-close");
  const contentStore = document.getElementById("modal-content-store");
  const triggers = document.querySelectorAll("[data-modal]");
  if (!overlay || !card || !body || !closeButton || !contentStore || triggers.length === 0) {
    return;
  }

  let triggerElement = null; // button that opened the modal, refocused on close

  function onKeydown(event) {
    if (event.key === "Escape") closeModal();
  }

  function openModal(key, trigger) {
    const panel = document.getElementById(`modal-${key}`);
    if (!panel) {
      // Bug class this guards against: a data-modal value with no matching
      // #modal-<value> element. Log loudly and abort before touching any
      // overlay/body/scroll state, so a bad trigger can't half-open things.
      console.error(`[modal] no content panel found for data-modal="${key}" (expected #modal-${key})`);
      return;
    }

    // If a different panel is currently on display (either because the
    // overlay was never closed and the user clicked another trigger, or —
    // less obviously — because closeModal() intentionally leaves the last
    // panel in place), return IT to the inert store before swapping.
    // body.replaceChildren() below would otherwise just detach the old
    // panel from the document instead of moving it anywhere: it becomes an
    // orphaned node no longer reachable by getElementById(), so the next
    // attempt to reopen THAT modal would silently fail at the guard above
    // and look exactly like "the modal system stopped responding".
    if (body.firstElementChild && body.firstElementChild !== panel) {
      contentStore.appendChild(body.firstElementChild);
    }

    body.replaceChildren(panel); // moves the panel out of the inert store

    const heading = panel.querySelector("h2");
    if (heading) card.setAttribute("aria-labelledby", heading.id);

    triggerElement = trigger;
    overlay.classList.add("is-open");
    document.body.style.overflow = "hidden"; // lock scroll so the 3D scene can't move underneath

    closeButton.focus();
    document.addEventListener("keydown", onKeydown);

    console.log("[modal] open", key); // TODO: remove once the reopen bug is confirmed fixed
  }

  function closeModal() {
    overlay.classList.remove("is-open");
    document.body.style.overflow = "";
    document.removeEventListener("keydown", onKeydown);

    if (triggerElement) triggerElement.focus();
    triggerElement = null;

    console.log("[modal] closed"); // TODO: remove once the reopen bug is confirmed fixed
  }

  triggers.forEach((trigger) => {
    trigger.addEventListener("click", () => {
      openModal(trigger.dataset.modal, trigger);
    });
  });

  closeButton.addEventListener("click", closeModal);

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeModal(); // click landed on the backdrop, not the card
  });
}

initModals();
