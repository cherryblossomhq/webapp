import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AnyCircuitElement } from "circuit-json";

// vi.mock factories are hoisted above imports, so anything they close over must
// be created with vi.hoisted (not a plain top-level const).
const h = vi.hoisted(() => {
  // Deferred so the test can hold the async KiCad export "in flight" and probe
  // the guard, then resolve/reject on demand.
  let resolveKicad: (() => void) | null = null;
  let rejectKicad: ((e: Error) => void) | null = null;
  const buildKicadProjectZip = vi.fn(
    () =>
      new Promise<Blob>((resolve, reject) => {
        resolveKicad = () =>
          resolve(new Blob(["zip"], { type: "application/zip" }));
        rejectKicad = (e: Error) => reject(e);
      })
  );
  return {
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
    buildKicadProjectZip,
    deferred: {
      resolve: () => resolveKicad?.(),
      reject: (e: Error) => rejectKicad?.(e),
    },
  };
});

vi.mock("sonner", () => ({
  toast: { success: h.toastSuccess, error: h.toastError },
}));
vi.mock("@/utils/kicadExport", () => ({
  buildKicadProjectZip: h.buildKicadProjectZip,
}));

const toastSuccess = h.toastSuccess;
const toastError = h.toastError;
const buildKicadProjectZip = h.buildKicadProjectZip;
const resolveKicad = () => h.deferred.resolve();
const rejectKicad = (e: Error) => h.deferred.reject(e);

// jsdom lacks the blob-download plumbing the component uses for downloads.
beforeEach(() => {
  URL.createObjectURL = vi.fn(() => "blob:mock");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});

import { ExportDialog } from "./ExportDialog";
import { useCircuitStore } from "@/store/circuitStore";

const CIRCUIT: AnyCircuitElement[] = [
  {
    type: "source_component",
    source_component_id: "sc1",
    name: "R1",
  } as unknown as AnyCircuitElement,
];

function seedEvaluatedCircuit() {
  act(() => {
    useCircuitStore.setState({ circuitJson: CIRCUIT });
  });
}

function resetStore() {
  act(() => {
    useCircuitStore.setState({ circuitJson: null });
  });
}

describe("ExportDialog — KiCad async export + guards", () => {
  beforeEach(() => {
    toastSuccess.mockClear();
    toastError.mockClear();
    buildKicadProjectZip.mockClear();
    seedEvaluatedCircuit();
  });

  afterEach(() => {
    resetStore();
    vi.restoreAllMocks();
  });

  it("renders a KiCad Project export row when the circuit is evaluated", () => {
    render(<ExportDialog open onOpenChange={() => {}} />);
    expect(screen.getByText("KiCad Project")).toBeInTheDocument();
  });

  it("disables the KiCad row when no evaluated circuit is available", () => {
    resetStore();
    render(<ExportDialog open onOpenChange={() => {}} />);
    const row = screen.getByText("KiCad Project").closest("button")!;
    expect(row).toBeDisabled();
  });

  it("shows a spinner on the running row while the async export is in flight", async () => {
    render(<ExportDialog open onOpenChange={() => {}} />);
    await userEvent.click(screen.getByText("KiCad Project").closest("button")!);

    await screen.findByLabelText("Exporting");
    expect(buildKicadProjectZip).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveKicad?.();
    });
  });

  it("blocks a concurrent second export while one is in flight", async () => {
    render(<ExportDialog open onOpenChange={() => {}} />);
    const kicadBtn = screen.getByText("KiCad Project").closest("button")!;
    await userEvent.click(kicadBtn);
    await screen.findByLabelText("Exporting");

    // Every row is disabled while exporting — clicking another does nothing.
    const jsonBtn = screen.getByText("Project JSON").closest("button")!;
    expect(jsonBtn).toBeDisabled();
    await userEvent.click(jsonBtn).catch(() => {});
    expect(toastSuccess).not.toHaveBeenCalled();

    await act(async () => {
      resolveKicad?.();
    });
  });

  it("closes the dialog and toasts success after the export resolves", async () => {
    const onOpenChange = vi.fn();
    render(<ExportDialog open onOpenChange={onOpenChange} />);
    await userEvent.click(screen.getByText("KiCad Project").closest("button")!);
    await screen.findByLabelText("Exporting");

    await act(async () => {
      resolveKicad?.();
    });

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("toasts an error and re-enables retry after the export rejects", async () => {
    const onOpenChange = vi.fn();
    render(<ExportDialog open onOpenChange={onOpenChange} />);
    const kicadBtn = screen.getByText("KiCad Project").closest("button")!;
    await userEvent.click(kicadBtn);
    await screen.findByLabelText("Exporting");

    await act(async () => {
      rejectKicad?.(new Error("converter blew up"));
    });

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(toastError).toHaveBeenCalledWith(
      "Export failed: KiCad Project",
      expect.objectContaining({ description: "converter blew up" })
    );
    // Dialog stays open on failure; spinner cleared so the row is usable again.
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Exporting")).not.toBeInTheDocument();

    // A retry actually fires a new export (exportedRef was reset on failure).
    await userEvent.click(kicadBtn);
    expect(buildKicadProjectZip).toHaveBeenCalledTimes(2);
    await act(async () => {
      resolveKicad?.();
    });
  });

  it("runs a synchronous export (Project JSON) and closes on success", async () => {
    const onOpenChange = vi.fn();
    render(<ExportDialog open onOpenChange={onOpenChange} />);
    await userEvent.click(screen.getByText("Project JSON").closest("button")!);
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
