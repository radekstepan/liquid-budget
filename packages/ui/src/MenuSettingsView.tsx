"use client";

import type { View } from "./Sidebar.js";
import { NAV_ITEMS, visibleViewCount } from "./navVisibility.js";
import { Button, Checkbox } from "@ynab/theme";

export function MenuSettingsView({
  visible,
  onToggle,
  privacyEnabled,
  onTogglePrivacy,
  onRegeneratePrivacyAmounts,
}: {
  visible: Record<View, boolean>;
  onToggle: (view: View, next: boolean) => void;
  privacyEnabled: boolean;
  onTogglePrivacy: (next: boolean) => void;
  onRegeneratePrivacyAmounts: () => void;
}) {
  const enabledCount = visibleViewCount(visible);

  return (
    <div className="p-5 y-scroll overflow-auto" style={{ background: "var(--y-row)" }}>
      <div className="max-w-[760px]">
        <div>
          <h1 className="text-[16px] font-bold" style={{ color: "var(--y-ink)" }}>
            Page Visibility
          </h1>
          <p className="y-hint text-[12px] mt-1 max-w-[560px]">
            Choose which pages appear in the left menu. Hidden pages still exist — they
            are just tucked out of the way.
          </p>
        </div>

        <div className="mt-4 overflow-hidden border rounded" style={{ borderColor: "var(--y-line)" }}>
          {NAV_ITEMS.map((item, idx) => {
            const on = visible[item.key];
            const isLastEnabled = on && enabledCount <= 1;
            return (
              <div
                key={item.key}
                className="px-3 py-2.5"
                style={{
                  borderTop: idx === 0 ? undefined : "1px solid var(--y-line)",
                }}
              >
                <Checkbox
                  checked={on}
                  disabled={isLastEnabled}
                  label={item.label}
                  onChange={(next) => {
                    if (!next && isLastEnabled) return;
                    onToggle(item.key, next);
                  }}
                />
                <div className="y-hint text-[11.5px] mt-1 ml-[19px]">{item.description}</div>
                {isLastEnabled && (
                  <div className="y-hint text-[11.5px] mt-0.5 ml-[19px]">
                    At least one page must stay visible.
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-8">
          <h1
            className="text-[16px] font-bold"
            style={{ color: "var(--y-ink)" }}
          >
            Privacy mode
          </h1>
          <p className="y-hint text-[12px] mt-1 max-w-[560px]">
            Disguise amounts and names for screenshots. Payees and accounts
            get realistic stand-in names, memos are hidden, and every amount
            is scaled by one random factor so totals still add up. Category
            names stay as they are. Editing is disabled while privacy mode
            is on, and your real data is never changed.
          </p>
        </div>

        <div className="mt-4">
          <Checkbox
            checked={privacyEnabled}
            label="Disguise amounts and names"
            onChange={onTogglePrivacy}
          />
          {privacyEnabled && (
            <div className="mt-2 ml-[19px]">
              <div className="y-hint text-[11.5px]">
                The disguise stays the same until you draw a new one.
              </div>
              <div className="mt-1.5">
                <Button onClick={onRegeneratePrivacyAmounts}>
                  New random amounts
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
