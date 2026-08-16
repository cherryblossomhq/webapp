import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { useCircuitStore } from "@/store/circuitStore";
import { useDialogReturnFocus } from "@/hooks/useDialogReturnFocus";
import { buildKicadProjectZip } from "@/utils/kicadExport";
import { log } from "@/utils/logger";

interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface ExportOption {
  label: string;
  description: string;
  ext: string;
  filename: string;
  run: (filename: string) => void | Promise<void>;
  disabled?: boolean;
  disabledReason?: string;
}

function sanitizeBase(title: string): string {
  // Match the sanitizer in EditorView so exported filenames are always safe.
  const safe = title
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f<>:"/\\|?*]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._]+|[._]+$/g, "")
    .slice(0, 80);
  return safe || "untitled";
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Defer the revoke so the webview has finished reading the blob before the
  // object URL is dropped — revoking synchronously can abort the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function download(content: string, filename: string, type: string) {
  downloadBlob(new Blob([content], { type }), filename);
}

export function ExportDialog({ open, onOpenChange }: ExportDialogProps) {
  // Use selectors so the dialog doesn't re-render on unrelated store changes.
  const metadata = useCircuitStore((s) => s.metadata);
  const tsxCode = useCircuitStore((s) => s.tsxCode);
  const circuitJson = useCircuitStore((s) => s.circuitJson);
  const getProjectData = useCircuitStore((s) => s.getProjectData);
  const getCircuitJsonForExport = useCircuitStore((s) => s.getCircuitJsonForExport);
  const getComponents = useCircuitStore((s) => s.getComponents);

  const components = getComponents();
  const base = sanitizeBase(metadata.title);

  const onCloseAutoFocus = useDialogReturnFocus(open);

  // Radix keeps DialogContent mounted (and its rows clickable) through the
  // close animation, so a quick double-click would fire the same download
  // twice. Allow one export per time the dialog is opened; reset on reopen.
  // A ref (not state) is what makes this reliable — it's mutated and read
  // synchronously, so a second click in the same tick is blocked.
  const exportedRef = useRef(false);
  useEffect(() => {
    if (open) exportedRef.current = false;
  }, [open]);

  // Async exports (KiCad) yield to the event loop while zipping, so the dialog
  // can be closed and reopened mid-export — which resets `exportedRef`. This
  // in-flight guard is NOT reset on reopen, so it blocks a second concurrent
  // run; the `exportingLabel` state survives reopen too (component stays
  // mounted) and drives the spinner on the running row.
  const inFlightRef = useRef(false);
  const [exportingLabel, setExportingLabel] = useState<string | null>(null);

  // Guarded export runner: kept off the `options` data so the ref access stays
  // in event-handler position (wired via onClick), not in the render path.
  const runExport = useCallback(
    async (opt: ExportOption) => {
      if (exportedRef.current || inFlightRef.current) return;
      exportedRef.current = true;
      inFlightRef.current = true;
      setExportingLabel(opt.label);
      try {
        await opt.run(opt.filename);
        toast.success(`Exported ${opt.filename}`, {
          description: "Saved to your Downloads folder",
        });
        onOpenChange(false);
      } catch (err) {
        exportedRef.current = false; // let the user retry after a failure
        log.error(`[export] ${opt.label} failed:`, err);
        toast.error(`Export failed: ${opt.label}`, {
          description: err instanceof Error ? err.message : String(err),
        });
      } finally {
        inFlightRef.current = false;
        setExportingLabel(null);
      }
    },
    [onOpenChange]
  );

  const options: ExportOption[] = [
    {
      label: "Project JSON",
      description: "Cherry Blossom project file — full circuit with layout data",
      ext: ".cherryblossom.json",
      filename: `${base}.cherryblossom.json`,
      run: (filename) => {
        const data = getProjectData();
        download(JSON.stringify(data, null, 2), filename, "application/json");
      },
    },
    {
      label: "tscircuit TSX",
      description: "tscircuit-compatible TSX source code",
      ext: ".tsx",
      filename: `${base}.tsx`,
      run: (filename) => {
        download(tsxCode, filename, "text/plain");
      },
    },
    {
      label: "Circuit JSON",
      description: "tscircuit circuit-json — the evaluated PCB as fab tools expect it",
      ext: ".circuit.json",
      filename: `${base}.circuit.json`,
      disabled: !circuitJson || circuitJson.length === 0,
      disabledReason: "Circuit hasn't finished evaluating yet",
      run: (filename) => {
        const json = getCircuitJsonForExport();
        if (!json || json.length === 0) {
          throw new Error("No evaluated circuit available to export");
        }
        download(JSON.stringify(json, null, 2), filename, "application/json");
      },
    },
    {
      label: "KiCad Project",
      description: "KiCad schematic, PCB, and project files, zipped",
      ext: ".kicad.zip",
      filename: `${base}.kicad.zip`,
      disabled: !circuitJson || circuitJson.length === 0,
      disabledReason: "Circuit hasn't finished evaluating yet",
      run: async (filename) => {
        const json = getCircuitJsonForExport();
        if (!json || json.length === 0) {
          throw new Error("No evaluated circuit available to export");
        }
        const zip = await buildKicadProjectZip(json, base);
        downloadBlob(zip, filename);
      },
    },
    {
      label: "BOM CSV",
      description: "Bill of materials for component ordering",
      ext: "_bom.csv",
      filename: `${base}_bom.csv`,
      disabled: components.length === 0,
      disabledReason: "Add components to enable BOM export",
      run: (filename) => {
        const lines = ["Designator,Type,Value,Footprint"];
        for (const comp of components) {
          lines.push(
            `"${comp.name}","${comp.type}","${comp.value}","${comp.footprint}"`
          );
        }
        download(lines.join("\n"), filename, "text/csv");
      },
    },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DialogHeader>
          <DialogTitle>Export Circuit</DialogTitle>
          <DialogDescription>
            <span className="font-mono text-foreground">{metadata.title}</span>
            {" · "}
            {components.length} {components.length === 1 ? "component" : "components"}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1">
          {options.map((opt, i) => (
            <div key={opt.label}>
              {i === 1 && <Separator className="my-1.5" />}
              <button
                onClick={() => runExport(opt)}
                disabled={opt.disabled || exportingLabel !== null}
                title={opt.disabled ? opt.disabledReason : undefined}
                className="w-full flex items-start gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-accent transition-colors group disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium group-hover:text-foreground">
                    {opt.label}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {opt.disabled && opt.disabledReason
                      ? opt.disabledReason
                      : opt.description}
                  </p>
                </div>
                <span className="shrink-0 text-xs font-mono text-muted-foreground bg-muted rounded px-1.5 py-0.5 mt-0.5">
                  {exportingLabel === opt.label ? (
                    <Loader2 className="size-3.5 animate-spin" aria-label="Exporting" />
                  ) : (
                    opt.ext
                  )}
                </span>
              </button>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
