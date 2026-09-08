import type { ReactNode } from 'react';
import { Check } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Slider } from '@/components/ui/slider';
import { FONT_OPTIONS, getFont } from '@/lib/label-options';
import type { MarkShape } from '@/lib/leather-label-svg';

export function VectorMarkPreview({
  x,
  y,
  size,
  shape,
  text,
  color,
  fontFamily,
}: {
  x: number;
  y: number;
  size: number;
  shape: MarkShape;
  text: string;
  color: string;
  fontFamily: string;
}) {
  const half = size / 2;
  const common = {
    fill: 'none',
    stroke: color,
    strokeWidth: Math.max(0.35, size * 0.055),
    strokeLinejoin: 'round' as const,
  };

  return (
    <g transform={`translate(${x} ${y})`}>
      {shape === 'circle' && (
        <circle cx="0" cy="0" r={half * 0.9} {...common} />
      )}
      {shape === 'oval' && (
        <ellipse cx="0" cy="0" rx={half * 0.96} ry={half * 0.7} {...common} />
      )}
      {shape === 'diamond' && (
        <polygon
          points={`0,-${half * 0.94} ${half * 0.86},0 0,${half * 0.94} -${half * 0.86},0`}
          {...common}
        />
      )}
      {shape === 'hexagon' && (
        <polygon
          points={`0,-${half * 0.94} ${half * 0.82},-${half * 0.47} ${half * 0.82},${half * 0.47} 0,${half * 0.94} -${half * 0.82},${half * 0.47} -${half * 0.82},-${half * 0.47}`}
          {...common}
        />
      )}
      {shape === 'shield' && (
        <path
          d={`M 0 -${half * 0.95} L ${half * 0.78} -${half * 0.6} L ${half * 0.68} ${half * 0.32} Q 0 ${half * 1.08} -${half * 0.68} ${half * 0.32} L -${half * 0.78} -${half * 0.6} Z`}
          {...common}
        />
      )}
      {shape === 'star' && (
        <polygon points={starPoints(half * 0.94, half * 0.43)} {...common} />
      )}
      <text
        x="0"
        y="0"
        fill={color}
        textAnchor="middle"
        dominantBaseline="middle"
        fontFamily={fontFamily}
        fontSize={Math.max(2.6, size * 0.34)}
        fontWeight="800"
        letterSpacing={Math.max(0.1, size * 0.025)}
      >
        {text}
      </text>
    </g>
  );
}

function starPoints(outerRadius: number, innerRadius: number) {
  return Array.from({ length: 10 }, (_, index) => {
    const radius = index % 2 === 0 ? outerRadius : innerRadius;
    const angle = -Math.PI / 2 + (index * Math.PI) / 5;
    return `${Math.cos(angle) * radius},${Math.sin(angle) * radius}`;
  }).join(' ');
}

export function PanelHeading({
  number,
  title,
  compact = false,
}: {
  number: string;
  title: string;
  compact?: boolean;
}) {
  return (
    <div className={compact ? 'mb-3' : 'mb-5'}>
      <p className="section-kicker">{number}</p>
      <h2
        className={compact ? 'text-lg font-semibold' : 'text-xl font-semibold'}
      >
        {title}
      </h2>
    </div>
  );
}

export function Divider() {
  return <div className="h-px bg-border" />;
}

export function SelectField({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <NativeSelect
        id={id}
        className="w-full"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((item) => (
          <NativeSelectOption key={item} value={item}>
            {item}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </div>
  );
}

export function SelectObjectField({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <NativeSelect
        id={id}
        className="w-full"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((item) => (
          <NativeSelectOption key={item.value} value={item.value}>
            {item.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </div>
  );
}

export function FontField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const selected = getFont(value);
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <NativeSelect
        id={id}
        className="w-full"
        value={value}
        style={{ fontFamily: selected.stack }}
        onChange={(event) => onChange(event.target.value)}
      >
        {FONT_OPTIONS.map((font) => (
          <NativeSelectOption key={font.id} value={font.id}>
            {font.group}｜{font.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <p className="font-preview" style={{ fontFamily: selected.stack }}>
        原野 YUANYE 1998
      </p>
    </div>
  );
}

export function TextField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        maxLength={40}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

export function DimensionInput({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          min="10"
          step="0.1"
          value={value}
          className="pr-10 tabular-nums"
          onChange={(event) => onChange(event.target.value)}
        />
        <span className="pointer-events-none absolute inset-y-0 right-3 grid place-items-center text-sm text-muted-foreground">
          mm
        </span>
      </div>
    </div>
  );
}

export function RangeField({
  id,
  label,
  value,
  unit,
  min,
  max,
  step,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  unit: string;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={id}>{label}</Label>
        <output className="text-sm tabular-nums text-muted-foreground">
          {value} {unit}
        </output>
      </div>
      <Slider
        id={id}
        min={min}
        max={max}
        step={step}
        value={[Math.min(max, Math.max(min, value))]}
        onValueChange={(nextValue) =>
          onChange(
            typeof nextValue === 'number' ? nextValue : (nextValue[0] ?? value),
          )
        }
        aria-label={label}
      />
    </div>
  );
}

export function ColorPicker({
  id,
  label,
  value,
  colors,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  colors: { name: string; value: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={id}>{label}</Label>
        <Input
          id={id}
          type="color"
          className="h-8 w-12 cursor-pointer p-1"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        {colors.map((color) => (
          <button
            key={color.value}
            type="button"
            title={color.name}
            aria-label={`使用${color.name}`}
            aria-pressed={value === color.value}
            onClick={() => onChange(color.value)}
            className={`color-swatch ${value === color.value ? 'color-swatch-active' : ''}`}
            style={{ backgroundColor: color.value }}
          />
        ))}
      </div>
    </div>
  );
}

export function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.045] px-4 py-3 text-white">
      <p className="text-sm text-white/48">{label}</p>
      <p className="mt-1 font-medium">{value}</p>
    </div>
  );
}

export function CheckRow({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 text-sm leading-5 text-muted-foreground">
      <Check
        className="mt-0.5 size-4 shrink-0 text-primary"
        aria-hidden="true"
      />
      <span>{text}</span>
    </div>
  );
}

export function StepNumber({ children }: { children: ReactNode }) {
  return (
    <span className="mr-2 inline-grid size-5 place-items-center rounded-full bg-foreground text-xs font-semibold text-background">
      {children}
    </span>
  );
}
