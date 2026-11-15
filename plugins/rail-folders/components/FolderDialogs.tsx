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
import { Input } from "@/components/ui/input";
import type { Folder } from "@/lib/folders";

/** Rename one folder. Shared by the rail's context menu and the settings page. */
export function RenameFolderDialog({
  folder,
  onClose,
  onSubmit,
}: {
  folder: Folder | null;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState("");

  useEffect(() => {
    setName(folder?.name ?? "");
  }, [folder]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = name.trim();
    if (next === "") return;
    onSubmit(next);
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
