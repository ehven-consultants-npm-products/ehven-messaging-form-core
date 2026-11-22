const states = new WeakMap();

/** Change visibility. The form adapter owns disabled/required policy for child controls. */
export function revealMessagingFields(group, expanded, { animate = false, duration = 200 } = {}) {
  if (!group?.ownerDocument || typeof expanded !== 'boolean' || !Number.isFinite(duration) || duration < 0 || duration > 2000) throw new TypeError('Invalid reveal target or options.');
  const view = group.ownerDocument.defaultView;
  let state = states.get(group);
  if (!state) {
    state = { original: { hidden: group.hidden, inert: group.inert, ariaHidden: group.getAttribute('aria-hidden') }, expanded: undefined, animation: undefined };
    states.set(group, state);
  }
  if (state.expanded === expanded) return;
  const startHeight = group.hidden ? 0 : group.getBoundingClientRect().height;
  const startOpacity = group.hidden ? 0 : Number.parseFloat(view.getComputedStyle(group).opacity);
  const startMargin = group.hidden ? '0px' : view.getComputedStyle(group).marginBlockStart;
  state.animation?.cancel();
  state.animation = undefined;
  state.expanded = expanded;
  group.inert = !expanded;
  if (expanded) group.removeAttribute('aria-hidden');
  else group.setAttribute('aria-hidden', 'true');
  group.hidden = false;
  const endHeight = expanded ? group.getBoundingClientRect().height : 0;
  const endMargin = expanded ? view.getComputedStyle(group).marginBlockStart : '0px';
  if (!animate || !duration || view.matchMedia?.('(prefers-reduced-motion: reduce)').matches || typeof group.animate !== 'function' || startHeight === endHeight) {
    group.hidden = !expanded;
    return;
  }
  const animation = group.animate([
    { height: `${startHeight}px`, marginBlockStart: startMargin, opacity: startOpacity, overflow: 'hidden' },
    { height: `${endHeight}px`, marginBlockStart: endMargin, opacity: expanded ? 1 : 0, overflow: 'hidden' },
  ], { duration, easing: 'ease-out', fill: 'both' });
  state.animation = animation;
  animation.finished.then(() => {
    if (states.get(group) !== state || state.animation !== animation) return;
    group.hidden = !expanded;
    animation.cancel();
    state.animation = undefined;
  }, () => {});
}

/** Restore only the attributes and animation owned by revealMessagingFields. */
export function restoreMessagingFields(group) {
  const state = states.get(group);
  if (!state) return;
  state.animation?.cancel();
  group.hidden = state.original.hidden;
  group.inert = state.original.inert;
  if (state.original.ariaHidden === null) group.removeAttribute('aria-hidden');
  else group.setAttribute('aria-hidden', state.original.ariaHidden);
  states.delete(group);
}
