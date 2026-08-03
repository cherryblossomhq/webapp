import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCircuitStore } from "@/store/circuitStore";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="ui-label text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

/**
 * The project-settings dialog body, without a trigger. Split out from
 * `ProjectMenu` because the compact toolbar has no room for a dedicated
 * "Project" button and opens this from its File menu instead — so the caller
 * has to be able to own the open state.
 */
export function ProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const metadata = useCircuitStore((s) => s.metadata);
  const setMetadata = useCircuitStore((s) => s.setMetadata);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Project settings</DialogTitle>
          <DialogDescription>Name your project.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <Field label="Title">
            <Input
              value={metadata.title}
              onChange={(e) => setMetadata(e.target.value)}
              className="h-8 text-xs"
            />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Project settings, surfaced as a toolbar modal. For now this is the project
 * name only. The "Project" trigger lives between the app name and the file
 * actions on the regular toolbar.
 */
export function ProjectMenu() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Project
      </Button>
      <ProjectDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

