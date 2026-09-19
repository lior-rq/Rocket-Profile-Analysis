/* Every primitive in every state, for eyeballing both themes. Dev only. */
import { useState } from "react";
import { Download, Play, Settings } from "lucide-react";
import { StepHead } from "@/components/common";
import { LineChart, ScatterChart, SeriesLegend } from "@/components/charts";
import { AnimatedNumber, Badge, Bar, Button, Card, Check, Chip, ConfirmDialog, DropZone, Field, Icon, IconButton, Input, KV, Kbd, LiveDot, NumberField, Pill, Problem, Radio, Range, Segmented, Select, Skeleton, Stat, StatGrid, Tabs, TabsContent, TabsList, TabsTrigger, TextField } from "@/components/ui";

export function DevUiPage() {
  const [seg, setSeg] = useState("a");
  const [n, setN] = useState<number | null>(42);
  const [r, setR] = useState(35);
  const [chk, setChk] = useState(true);
  const [dlg, setDlg] = useState(false);
  const [big, setBig] = useState(45000);
  return (
    <>
      <StepHead title="Primitives" sub="Every component in every state. Dev only." kicker="dev" />
      <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
        <Card title="Buttons" sub="primary, ghost, chip, danger, link, icon">
          <div className="flex flex-wrap gap-2 items-center">
            <Button variant="primary"><Icon of={Play} size="sm" />Primary</Button><Button variant="primary" disabled>Disabled</Button><Button variant="primary" size="sm">Small</Button>
            <Button>Ghost</Button><Button disabled>Disabled</Button><Button size="sm">Small</Button>
            <Button variant="chip">Chip</Button><Button variant="chip" on>On</Button><Button variant="chip" tone="good">Good</Button><Button variant="chip" tone="bad" size="sm">Bad sm</Button>
            <Button variant="danger">Danger</Button><Button variant="link">Link</Button>
            <IconButton icon={Settings} label="settings" /><IconButton icon={Download} label="download" on dot="bad" />
          </div>
        </Card>
        <Card title="Labels">
          <div className="flex flex-wrap gap-2 items-center">
            <Pill tone="muted">muted</Pill><Pill tone="accent">accent</Pill><Pill tone="good">good</Pill><Pill tone="warn">warn</Pill><Pill tone="bad">bad</Pill><Pill tone="info">info</Pill><Pill tone="good" lower>lower case</Pill>
            <Badge status="ok" /><Badge status="stale" /><Badge status="error" /><Badge status="running" /><Badge status="todo" /><Badge status="unchecked" />
            <Chip>chip</Chip><Chip on>on</Chip><Chip sm tone="warn">warn sm</Chip><Chip disabled>disabled</Chip>
            <Kbd>space</Kbd><LiveDot /><LiveDot tone="good" /><LiveDot tone="info" />
          </div>
          <Segmented value={seg} onChange={setSeg} options={[{ value: "a", label: "alpha" }, { value: "b", label: "beta" }, { value: "c", label: "gamma", disabled: true }]} />
          <Segmented sm value={seg} onChange={setSeg} options={[{ value: "a", label: "1x" }, { value: "b", label: "2x" }, { value: "c", label: "4x" }]} />
        </Card>
        <Card title="Fields">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Text" hint="commits on blur"><TextField value="hello" onCommit={() => {}} /></Field>
            <Field label="Number" hint="arrow keys step" edited><NumberField value={n} onChange={setN} step={0.5} /></Field>
            <Field label="Select"><Select defaultValue="b"><option value="a">alpha</option><option value="b">beta</option></Select></Field>
            <Field label="Disabled"><Input disabled value="nope" readOnly /></Field>
            <Field label="Range" readout={r}><Range value={r} min={0} max={100} step={1} onChange={setR} /></Field>
            <Field label="Range disabled"><Range value={60} min={0} max={100} step={1} onChange={() => {}} disabled /></Field>
          </div>
          <div className="flex flex-wrap gap-4">
            <Check checked={chk} onChange={setChk}>checked</Check><Check checked={false} onChange={() => {}}>unchecked</Check><Check checked={false} indeterminate onChange={() => {}}>indeterminate</Check><Check checked disabled onChange={() => {}}>disabled</Check>
            <Radio checked onChange={() => {}} name="d">on</Radio><Radio checked={false} onChange={() => {}} name="d">off</Radio>
          </div>
        </Card>
        <Card title="Indicators">
          <StatGrid><Stat label="plain" value={fmtBig(big)} unit="ft" /><Stat label="ok" value="1.234" tone="ok" sub="sub line" /><Stat label="warn" value="0.91" tone="warn" /><Stat label="bad" value="fail" tone="bad" text /><Stat label="accent" value={<AnimatedNumber value={big} format={fmtBig} />} tone="accent" unit="ft" /></StatGrid>
          <Button size="sm" variant="chip" onClick={() => setBig(Math.round(30000 + Math.random() * 30000))}>respring the number</Button>
          <Bar fraction={0.35} /><Bar fraction={0.7} tone="warn" /><Bar fraction={1} tone="bad" /><Bar fraction={0.5} tone="good" /><Bar indeterminate tone="info" />
          <KV pairs={[["key", "value"], ["another key", "another value that is long enough to wrap onto a second line if the card is narrow"]]} />
          <Skeleton lines={3} />
        </Card>
        <Card title="Problems">
          <Problem tone="info">Info: something to know.</Problem><Problem tone="ok">Ok: something went right.</Problem><Problem tone="warn">Warn: something to check.</Problem><Problem tone="err">Error: something broke.</Problem><Problem tone="note">Note: quiet.</Problem>
        </Card>
        <Card title="Tabs, drop zone, dialog" glow="accent">
          <Tabs defaultValue="one"><TabsList><TabsTrigger value="one" extra={3}>One</TabsTrigger><TabsTrigger value="two">Two</TabsTrigger><TabsTrigger value="three" extra="new">Three</TabsTrigger></TabsList><TabsContent value="one" className="mt-3 text-[13px] text-ink-2">first</TabsContent><TabsContent value="two" className="mt-3 text-[13px] text-ink-2">second</TabsContent><TabsContent value="three" className="mt-3 text-[13px] text-ink-2">third</TabsContent></Tabs>
          <DropZone>Drop files here</DropZone><DropZone over>Dragging over</DropZone>
          <div><Button onClick={() => setDlg(true)}>Open dialog</Button></div>
          <ConfirmDialog open={dlg} onOpenChange={setDlg} title="A dialog" body="Springs in, blurs the page behind, traps focus." okLabel="Sure" onOk={() => {}} />
        </Card>
        <Card title="Charts" className="lg:col-span-2" static>
          <SeriesLegend items={[{ name: "Mach", color: "--series-1" }, { name: "altitude", color: "--series-2", dash: true }]} />
          <LineChart series={[{ name: "Mach", x: XS, y: XS.map((t) => 2.2 * Math.exp(-((t - 6) ** 2) / 30)) }, { name: "altitude [ft]", x: XS, y: XS.map((t) => 45000 * Math.sin(Math.min(t / 60, 1) * Math.PI / 2)), axis: "y2", dash: true }]} xLabel="time [s]" yLabel="Mach" y2Label="altitude [ft]"
                     refs={[{ y: 1.2, label: "M 1.2", color: "--limit" }, { y: 0.9, label: "M 0.9", color: "--good" }, { y: 45000, label: "target", axis: "y2", color: "--target" }]} markers={[{ x: 4.3, label: "burnout", color: "--ev-burnout" }, { x: 5.8, label: "ignition", color: "--ev-ign" }]} height={280} />
          <ScatterChart points={PTS} xLabel="Mach at separation" yLabel="apogee [ft]" height={300} band={{ y0: 44500, y1: 45500, label: "target band" }} xrefs={[{ x: 1.2, label: "M 1.2", color: "--limit" }]} color={(q) => q.row.tok} shape={(q) => q.row.shape} selectedKey="p3" tip={(q) => [["design", q.key], ["apogee", String(Math.round(q.y))]]} />
        </Card>
        <Card title="Busy card" busy><p className="text-[13px]">Content dims while a request is in flight.</p></Card>
        <Card title="Static card" static tight><p className="text-[13px]">No lift on hover: hosts a scrolling table.</p></Card>
        <Card title="Ring good" glow="good"><p className="text-[13px]">A live or finished process.</p></Card>
        <Card title="Ring warn" glow="warn"><p className="text-[13px]">Stale.</p></Card>
      </div>
    </>
  );
}
const fmtBig = (x: number) => Math.round(x).toLocaleString();
const XS = Array.from({ length: 121 }, (_, i) => i * 0.5);
const PTS = Array.from({ length: 24 }, (_, i) => ({ x: 0.6 + (i % 8) * 0.18, y: 38000 + ((i * 7919) % 15000), key: "p" + i, row: { tok: ["--status-solved", "--status-over", "--status-under", "--status-unsolved"][i % 4], shape: ["circle", "square", "diamond"][i % 3] } }));
