// Browser-history integration so the phone/OS Back button walks back through the
// app's views (movie detail → movie list → libraries) instead of leaving the
// app entirely. It's an SPA with no router, so nothing was pushing history and
// Back left the page on the first press.
//
// Model: each view that opens registers a "closer" and pushes one history entry.
// A popstate (hardware Back) pops the top closer and runs it. In-page "back"
// buttons call goBack(), which just does history.back() — so both the hardware
// button and the on-screen button take exactly the same path.

const closers: Array<() => void> = [];
let installed = false;

function install(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("popstate", () => {
    const close = closers.pop();
    if (close) close();
  });
}

/** Open a view: register how to close it and push a matching history entry. */
export function pushView(close: () => void): void {
  install();
  closers.push(close);
  try {
    history.pushState({ amcDepth: closers.length }, "");
  } catch {
    /* history unavailable — degrade to no back integration */
  }
}

/** Programmatic back (an on-screen back button); mirrors the hardware Back. */
export function goBack(): void {
  if (closers.length) history.back(); // popstate runs the top closer
}

/** Remove a registered closer without navigating — for a component that unmounts
 *  while its closer might still be on the stack, so the stack can't leak. */
export function dropView(close: () => void): void {
  const i = closers.lastIndexOf(close);
  if (i !== -1) closers.splice(i, 1);
}
