import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmDialog } from "./ConfirmDialog";

describe("ConfirmDialog", () => {
  const baseProps = {
    open: true,
    onOpenChange: () => {},
    title: "Discard work?",
    message: "This will erase the current circuit.",
    onConfirm: () => {},
  };

  it("renders title and message when open", () => {
    render(<ConfirmDialog {...baseProps} />);
    expect(screen.getByText("Discard work?")).toBeInTheDocument();
    expect(
      screen.getByText("This will erase the current circuit.")
    ).toBeInTheDocument();
  });

  it("renders nothing when closed", () => {
    render(<ConfirmDialog {...baseProps} open={false} />);
    expect(screen.queryByText("Discard work?")).not.toBeInTheDocument();
  });

  it("fires onConfirm when the confirm button is clicked", async () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        {...baseProps}
        confirmLabel="Discard"
        onConfirm={onConfirm}
      />
    );
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("requests close when the cancel button is clicked", async () => {
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog
        {...baseProps}
        cancelLabel="Keep"
        onOpenChange={onOpenChange}
      />
    );
    await userEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("requests close when Escape is pressed", async () => {
    const onOpenChange = vi.fn();
    render(<ConfirmDialog {...baseProps} onOpenChange={onOpenChange} />);
    await userEvent.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
