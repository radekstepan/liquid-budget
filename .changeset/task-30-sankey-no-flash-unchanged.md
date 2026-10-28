---
"@ynab/ui": patch
---

## No flash in unchanged Sankey arms on hover switch (task-30)

Moving hover directly from one merchant/category to another no longer flashes ribbons, bars, or labels that stay backgrounded in both states.

Notes: root cause was a commit-timeline split, not paint — hover sets were coalesced through a rAF throttle while hover-leaves cleared synchronously, so every A → B switch committed A → null → B across two frames and flashed each unchanged arm dim → rest → dim for a frame (task-29's transition removal could not fix this: the intermediate rest frame still painted). The Sankey's hover-leaves now ride the same rAF throttle as the sets, so leave+move coalesce into one commit; `useRafThrottledSet` learned to deliver null payloads (a pending clear is a real value now, tracked by an explicit flag instead of the null slot). Keys were already stable and the spotlight derivation already memoized, and the z-reorder preserves DOM identity (stable keys — React only re-sequences position, never remounts), so with the single commit, unchanged arms keep identical attributes and DOM nodes with no repaint trigger. True hover-leave lands one frame later (imperceptible); Bars hover and the view/dimension/sort/threshold resets are untouched. Covered by a new test asserting a deferred-frame A → B switch shows no intermediate rest state and unchanged arms keep identical paint attributes and DOM node identity.
