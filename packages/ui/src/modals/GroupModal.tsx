"use client";

import { useState } from "react";
import { TextField } from "@ynab/theme";
import { Modal, Field, Btn } from "../ui.js";
import { inputClass } from "./shared.js";

export function GroupModal({
  initialName,
  onClose,
  onSave,
}: {
  initialName?: string;
  onClose: () => void;
  onSave: (name: string) => void;
}) {
  const [name, setName] = useState(initialName ?? "");
  return (
    <Modal
      title={initialName ? "Rename Group" : "New Category Group"}
      onClose={onClose}
      footer={
        <>
          <div className="flex items-center gap-2 mr-auto">
            <Btn onClick={onClose}>Cancel</Btn>
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <Btn
              variant="primary"
              onClick={() => name.trim() && onSave(name.trim())}
            >
              Save
            </Btn>
          </div>
        </>
      }
    >
      <Field label="Group Name">
        <TextField value={name} onChange={(e) => setName(e.target.value)} autoFocus className={inputClass} />
      </Field>
    </Modal>
  );
}
