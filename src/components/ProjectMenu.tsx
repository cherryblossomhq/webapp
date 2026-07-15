import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
 * Project settings, surfaced as a toolbar modal. For now this is the project
 * name only. The "Project" trigger lives between the app name and the file
 * actions.
 */
export function ProjectMenu() {
  const metadata = useCircuitStore((s) => s.metadata);
  const setMetadata = useCircuitStore((s) => s.setMetadata);

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          Project
        </Button>
      </DialogTrigger>
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
