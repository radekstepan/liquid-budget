"use client";

import { Icon, THEMES, type ThemeId, type ThemeMeta } from "@ynab/theme";

function ThemePreview({ theme }: { theme: ThemeMeta }) {
  const { sideTop, sideBot, accent } = theme.swatches;
  return (
    <div
      aria-hidden="true"
      className="flex h-[64px] w-full overflow-hidden rounded-[3px]"
      style={{
        border: "1px solid var(--y-line-soft)",
      }}
    >
      <div
        className="relative flex w-[42%] flex-col justify-center gap-[5px] px-2.5"
        style={{
          background: `linear-gradient(180deg, ${sideTop} 0%, ${sideBot} 100%)`,
        }}
      >
        {theme.id === "classic" && (
          <div className="y-theme-pattern y-theme-pattern--classic" />
        )}
        <div
          className="relative h-[5px] w-[70%] rounded-[2px]"
          style={{ background: "rgba(255,255,255,0.85)" }}
        />
        <div
          className="relative h-[5px] w-[55%] rounded-[2px]"
          style={{ background: "rgba(255,255,255,0.45)" }}
        />
        <div
          className="relative h-[5px] w-[62%] rounded-[2px]"
          style={{ background: "rgba(255,255,255,0.45)" }}
        />
      </div>
      <div
        className="flex flex-1 flex-col justify-center gap-[5px] px-2.5"
        style={{ background: "var(--y-row)" }}
      >
        <div className="flex items-center gap-1.5">
          <div
            className="h-[10px] w-[34px] rounded-[5px]"
            style={{ background: accent }}
          />
          <div
            className="h-[5px] w-[40%] rounded-[2px]"
            style={{ background: "var(--y-line)" }}
          />
        </div>
        <div
          className="h-[5px] w-[85%] rounded-[2px]"
          style={{ background: "var(--y-line-soft)" }}
        />
        <div
          className="h-[5px] w-[70%] rounded-[2px]"
          style={{ background: "var(--y-line-soft)" }}
        />
      </div>
    </div>
  );
}

export function ThemesView({
  themeId,
  onSelect,
}: {
  themeId: ThemeId;
  onSelect: (id: ThemeId) => void;
}) {
  return (
    <div className="p-5 y-scroll overflow-auto" style={{ background: "var(--y-row)" }}>
      <div className="max-w-[760px]">
        <div>
          <h1 className="text-[16px] font-bold" style={{ color: "var(--y-ink)" }}>
            Themes
          </h1>
          <p className="y-hint text-[12px] mt-1 max-w-[560px]">
            Recolor the sidebar and matching accents. Your choice is remembered
            on this device.
          </p>
        </div>

        <div
          role="radiogroup"
          aria-label="Themes"
          className="mt-4 grid gap-3"
          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))" }}
        >
          {THEMES.map((theme) => {
            const active = theme.id === themeId;
            return (
              <button
                key={theme.id}
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={theme.label}
                onClick={() => onSelect(theme.id)}
                className="cursor-pointer rounded p-2.5 text-left"
                style={{
                  background: "var(--y-panel-alt)",
                  border: "1px solid var(--y-line)",
                  boxShadow: active
                    ? "0 0 0 2px var(--y-blue)"
                    : "0 1px 0 rgba(255,255,255,0.8) inset",
                }}
              >
                <ThemePreview theme={theme} />
                <div className="mt-2 flex items-center gap-1.5">
                  <span
                    className="text-[13px] font-bold"
                    style={{ color: "var(--y-ink)" }}
                  >
                    {theme.label}
                  </span>
                  {active && (
                    <span
                      className="ml-auto inline-flex"
                      style={{ color: "var(--y-blue)" }}
                      aria-hidden="true"
                    >
                      <Icon name="check" size={13} />
                    </span>
                  )}
                </div>
                <div className="y-hint text-[11.5px] mt-0.5">
                  {theme.description}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
