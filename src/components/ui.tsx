import React, { useState } from "react";
import { copy, short } from "../lib/format";
import type { Warning } from "../lib/privacy";

export function Panel(p: {
  title: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  fill?: boolean;
  tight?: boolean;
  gold?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <div className={`panel ${p.fill ? "fill" : ""} ${p.className ?? ""}`} style={p.style}>
      <div className={`ph ${p.gold ? "gold" : ""}`}>
        <span>{p.title}</span>
        {p.right && <span className="r">{p.right}</span>}
      </div>
      <div className={`pb ${p.tight ? "tight" : ""}`}>{p.children}</div>
    </div>
  );
}

export function Btn(
  p: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: "primary" | "ghost" | "danger" | "gold" | "default";
    size?: "xs" | "sm" | "lg";
    block?: boolean;
    busy?: boolean;
    active?: boolean;
  },
) {
  const { variant = "default", size, block, busy, active, className, children, ...rest } = p;
  return (
    <button
      {...rest}
      disabled={rest.disabled || busy}
      className={`btn ${variant !== "default" ? variant : ""} ${size ?? ""} ${block ? "block" : ""} ${active ? "active" : ""} ${busy ? "spin" : ""} ${className ?? ""}`}
    >
      {children}
    </button>
  );
}

export function Field(p: { label: string; hint?: string; children: React.ReactNode; className?: string; style?: React.CSSProperties }) {
  return (
    <div className={`field ${p.className ?? ""}`} style={p.style}>
      <label>{p.label}</label>
      {p.children}
      {p.hint && <span className="hint">{p.hint}</span>}
    </div>
  );
}

export function Input(p: React.InputHTMLAttributes<HTMLInputElement> & { mono?: boolean; invalid?: boolean }) {
  const { mono, invalid, className, ...rest } = p;
  return <input {...rest} className={`inp ${mono ? "mono" : ""} ${invalid ? "err" : ""} ${className ?? ""}`} spellCheck={false} autoComplete="off" />;
}

export function Select(p: React.SelectHTMLAttributes<HTMLSelectElement>) {
  const { className, ...rest } = p;
  return <select {...rest} className={`sel ${className ?? ""}`} />;
}

export function TextArea(p: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className, ...rest } = p;
  return <textarea {...rest} className={`ta ${className ?? ""}`} spellCheck={false} />;
}

export function Prompt(p: { value: string; onChange: (v: string) => void; placeholder?: string; onEnter?: () => void; autoFocus?: boolean; prefix?: string }) {
  return (
    <div className="prompt">
      <span>{p.prefix ?? ">"}</span>
      <input
        value={p.value}
        placeholder={p.placeholder}
        autoFocus={p.autoFocus}
        spellCheck={false}
        onChange={(e) => p.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") p.onEnter?.();
        }}
      />
    </div>
  );
}

export function Seg<T extends string>(p: { options: readonly T[]; value: T; onChange: (v: T) => void; labels?: Record<string, string> }) {
  return (
    <div className="seg">
      {p.options.map((o) => (
        <button key={o} className={o === p.value ? "active" : ""} onClick={() => p.onChange(o)}>
          {p.labels?.[o] ?? o}
        </button>
      ))}
    </div>
  );
}

export function Dot(p: { state: "ok" | "warn" | "err" | "off" | "or"; title?: string }) {
  return <span className={`dot ${p.state}`} title={p.title} />;
}

export function Chip(p: { children: React.ReactNode; tone?: "or" | "gold" | "ok" | "warn" | "err"; title?: string }) {
  return (
    <span className={`chip ${p.tone ?? ""}`} title={p.title}>
      {p.children}
    </span>
  );
}

export function Kv(p: { items: [React.ReactNode, React.ReactNode][]; wrap?: boolean }) {
  return (
    <div className="kv">
      {p.items.map(([k, v], i) => (
        <React.Fragment key={i}>
          <span className="k">{k}</span>
          <span className={`v ${p.wrap ? "wrap" : ""}`}>{v}</span>
        </React.Fragment>
      ))}
    </div>
  );
}

export function Addr(p: { value: string | null | undefined; full?: boolean; head?: number; tail?: number }) {
  const [c, setC] = useState(false);
  if (!p.value) return <span className="dim">-</span>;
  return (
    <span
      className="addr"
      title={p.value}
      onClick={async () => {
        if (await copy(p.value!)) {
          setC(true);
          setTimeout(() => setC(false), 900);
        }
      }}
    >
      {p.full ? p.value : short(p.value, p.head ?? 8, p.tail ?? 8)}
      {c && <span className="or"> copied</span>}
    </span>
  );
}

export function Banner(p: { tone?: "warn" | "err" | "or" | "ok" | "info"; children: React.ReactNode }) {
  return <div className={`banner ${p.tone && p.tone !== "info" ? p.tone : ""}`}>{p.children}</div>;
}

export function Warnings(p: { items: Warning[]; compact?: boolean }) {
  if (!p.items.length) return null;
  const worst = p.items.some((w) => w.level === "crit") ? "err" : p.items.some((w) => w.level === "warn") ? "warn" : "info";
  return (
    <div className={`banner ${worst === "info" ? "" : worst}`}>
      {!p.compact && <b>PRIVACY</b>}
      <ul>
        {p.items.map((w) => (
          <li key={w.code}>
            <span className={w.level === "crit" ? "err" : w.level === "warn" ? "warn" : "muted"}>[{w.level}]</span> {w.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ErrLine(p: { e: string | null | undefined }) {
  if (!p.e) return null;
  return <div className="banner err">{p.e}</div>;
}

export function Tabs<T extends string>(p: { tabs: { id: T; label: string; gold?: boolean }[]; active: T; onChange: (t: T) => void; right?: React.ReactNode }) {
  return (
    <div className="tabs">
      {p.tabs.map((t) => (
        <button key={t.id} className={`${t.gold ? "gold" : ""} ${t.id === p.active ? "active" : ""}`} onClick={() => p.onChange(t.id)}>
          {t.label}
        </button>
      ))}
      {p.right && <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", paddingRight: 8 }}>{p.right}</span>}
    </div>
  );
}

export function Modal(p: { title: string; onClose: () => void; children: React.ReactNode; width?: number }) {
  return (
    <div className="modal-bg" onClick={p.onClose}>
      <div className="modal" style={{ width: p.width }} onClick={(e) => e.stopPropagation()}>
        <Panel title={p.title} right={<Btn size="xs" variant="ghost" onClick={p.onClose}>ESC</Btn>}>
          {p.children}
        </Panel>
      </div>
    </div>
  );
}

export function Empty(p: { children: React.ReactNode }) {
  return <div className="dim small" style={{ padding: "6px 2px" }}>{p.children}</div>;
}

export function Th(p: { children?: React.ReactNode; num?: boolean; w?: number | string }) {
  return (
    <th className={p.num ? "num" : ""} style={{ width: p.w }}>
      {p.children}
    </th>
  );
}
export function Td(p: { children?: React.ReactNode; num?: boolean; className?: string; title?: string; wrap?: boolean; colSpan?: number }) {
  return (
    <td className={`${p.num ? "num" : ""} ${p.wrap ? "wrapcell" : ""} ${p.className ?? ""}`} title={p.title} colSpan={p.colSpan}>
      {p.children}
    </td>
  );
}

export function Pnl(p: { v: number | null | undefined; fmt: (n: number) => string }) {
  if (p.v == null || !isFinite(p.v)) return <span className="dim">-</span>;
  return <span className={p.v > 0 ? "pnl-pos" : p.v < 0 ? "pnl-neg" : ""}>{p.v > 0 ? "+" : ""}{p.fmt(p.v)}</span>;
}
