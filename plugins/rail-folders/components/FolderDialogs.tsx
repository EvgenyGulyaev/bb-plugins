import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { DEFAULT_FOLDER_ICON, type Folder } from "@/lib/folders";

/** BB icon names offered when picking a folder mark. */
export const FOLDER_ICON_CHOICES = [
  "Folder",
  "Briefcase",
  "House",
  "Wrench",
  "Terminal",
  "LayoutGrid",
  "Star",
  "Bookmark",
  "Bug",
  "Rocket",
  "Settings",
  "MessageSquare",
  "Globe",
  "Database",
  "Code",
  "Calendar",
  "Mail",
  "Palette",
] as const;

/**
 * The icon grid shared by the create and rename dialogs. A radio group, so
 * arrow keys walk the marks and the dialog keeps exactly one choice.
 */
function FolderIconPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (icon: string) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Иконка папки"
      className="grid grid-cols-6 gap-1"
    >
      {FOLDER_ICON_CHOICES.map((name) => {
        const checked = name === value;
        return (
          <button
            key={name}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={name}
            onClick={() => onChange(name)}
            className={
              "flex h-8 items-center justify-center rounded-md border text-muted-foreground outline-none transition focus-visible:ring-1 focus-visible:ring-ring " +
              (checked
                ? "border-foreground bg-state-active text-foreground"
                : "border-border hover:bg-state-hover")
            }
          >
            <Icon
              name={name}
              fallback={DEFAULT_FOLDER_ICON}
              className="size-4"
              aria-hidden="true"
            />
          </button>
        );
      })}
    </div>
  );
}

/**
 * Create an empty folder. The modal picks the name and mark only: no icon is
 * claimed, so the folder arrives empty and icons are dragged in afterwards.
 */
export function CreateFolderDialog({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (input: { name: string; icon: string }) => void;
}) {
  const [name, setName] = useState("Папка");
  const [icon, setIcon] = useState<string>(DEFAULT_FOLDER_ICON);

  useEffect(() => {
    if (!open) return;
    setName("Папка");
    setIcon(DEFAULT_FOLDER_ICON);
  }, [open]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = name.trim();
    if (next === "") return;
    onCreate({ name: next, icon });
    onClose();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Новая папка</DialogTitle>
          <DialogDescription>
            Папка появится на рейле пустой: иконки добавите перетаскиванием.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <FolderIconPicker value={icon} onChange={setIcon} />
          <Input
            aria-label="Название папки"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={60}
            autoFocus
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Отмена
            </Button>
            <Button type="submit" disabled={name.trim() === ""}>
              OK
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Rename a folder and, optionally, change its mark. */
export function RenameFolderDialog({
  folder,
  onClose,
  onSubmit,
}: {
  folder: Folder | null;
  onClose: () => void;
  onSubmit: (name: string, icon: string) => void;
}) {
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<string>(DEFAULT_FOLDER_ICON);

  useEffect(() => {
    setName(folder?.name ?? "");
    setIcon(folder?.icon ?? DEFAULT_FOLDER_ICON);
  }, [folder]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = name.trim();
    if (next === "") return;
    onSubmit(next, icon);
    onClose();
  };

  return (
    <Dialog
      open={folder !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Переименовать папку</DialogTitle>
          <DialogDescription>
            Новое название появится на рейле.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <FolderIconPicker value={icon} onChange={setIcon} />
          <Input
            aria-label="Название папки"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={60}
            autoFocus
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Отмена
            </Button>
            <Button type="submit" disabled={name.trim() === ""}>
              Сохранить
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A destructive action that touches only this plugin's own arrangement. */
export function DeleteFolderDialog({
  folder,
  onClose,
  onConfirm,
}: {
  folder: Folder | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={folder !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Удалить папку?</DialogTitle>
          <DialogDescription>
            «{folder?.name}» исчезнет, а её иконки вернутся в рейл по одной.
            Плагины и панели останутся на месте.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Отмена
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            Удалить папку
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
