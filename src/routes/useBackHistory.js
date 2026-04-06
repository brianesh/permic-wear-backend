/**
 * useBackHistory.js
 *
 * Syncs the phone/browser back button with the app's navigation.
 *
 * How it works:
 *   - Every time the app navigates to a new "page", call pushHistory(page).
 *     This pushes a state entry into the browser history stack.
 *   - When the user presses the physical back button (or browser back),
 *     the `popstate` event fires and we call setPage() with the previous page.
 *   - On first mount we replace the initial history state so we always
 *     have a clean baseline entry.
 *
 * Usage in App.jsx:
 *   const { pushHistory } = useBackHistory(page, setPage, startPage);
 *   // Then call pushHistory(newPage) whenever you navigate.
 */

import { useEffect, useRef, useCallback } from 'react';

export function useBackHistory(currentPage, setPage, startPage) {
  const isPopping = useRef(false); // flag: back button fired, don't re-push

  // On mount: set up the initial state
  useEffect(() => {
    // Replace the very first entry so we know where we started
    window.history.replaceState({ page: currentPage }, '', window.location.pathname);

    const onPop = (event) => {
      const state = event.state;
      if (state?.page) {
        isPopping.current = true;
        setPage(state.page);
      } else {
        // Nothing in state — we're at the bottom of the stack, go to start
        isPopping.current = true;
        setPage(startPage);
      }
    };

    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Call this whenever the app navigates to a new page
  const pushHistory = useCallback((newPage) => {
    if (isPopping.current) {
      // This navigation was triggered by the back button — don't push again
      isPopping.current = false;
      return;
    }
    // Only push if it's actually a new page
    const current = window.history.state?.page;
    if (current === newPage) return;
    window.history.pushState({ page: newPage }, '', window.location.pathname);
  }, []);

  return { pushHistory };
}


/**
 * useModalBackButton
 *
 * For modals/overlays: pressing back closes the modal instead of navigating away.
 *
 * Usage:
 *   const closeModal = useModalBackButton(isOpen, () => setIsOpen(false));
 *
 * When isOpen becomes true, pushes a "modal" state into history.
 * When user presses back, pops that state → calls onClose.
 */
export function useModalBackButton(isOpen, onClose) {
  useEffect(() => {
    if (!isOpen) return;

    // Push a sentinel state for this modal
    window.history.pushState({ modal: true }, '', window.location.pathname);

    const onPop = (event) => {
      // If we popped the modal sentinel, close the modal
      if (!event.state?.modal) {
        onClose();
      }
    };

    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      // If modal closes programmatically (not via back), clean up the extra history entry
      if (window.history.state?.modal) {
        window.history.back();
      }
    };
  }, [isOpen, onClose]);
}
