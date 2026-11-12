import { describe, expect, it } from "vitest";

import {
  isCandidateString,
  missingKey,
  normalizeKey,
  translateValue,
} from "./translate.js";

const DICT = {
  Settings: "Настройки",
  "New thread": "Новый тред",
  Loading: "Загрузка",
  Same: "Same",
};

describe("normalizeKey", () => {
  it("сжимает пробелы и снимает края", () => {
    expect(normalizeKey("  New   thread \n")).toBe("New thread");
  });
});

describe("isCandidateString", () => {
  it("берёт подписи с латинскими буквами", () => {
    expect(isCandidateString("Settings")).toBe(true);
  });

  it("отбрасывает пустое, числа и слишком длинное", () => {
    expect(isCandidateString("   ")).toBe(false);
    expect(isCandidateString("42")).toBe(false);
    expect(isCandidateString("·")).toBe(false);
    expect(isCandidateString("x".repeat(241))).toBe(false);
    // Длинные описания в настройках — законные подписи интерфейса.
    expect(isCandidateString("Tint browser tabs to tell instances apart.")).toBe(
      true,
    );
  });
});

describe("translateValue", () => {
  it("переводит точное совпадение", () => {
    expect(translateValue(DICT, "Settings")).toBe("Настройки");
  });

  it("сохраняет краевые пробелы, которые ставит React", () => {
    expect(translateValue(DICT, "  Settings ")).toBe("  Настройки ");
  });

  it("сжимает внутренние пробелы при поиске ключа", () => {
    expect(translateValue(DICT, "New   thread")).toBe("Новый тред");
  });

  it("переносит концевой знак, которого нет в словаре", () => {
    expect(translateValue(DICT, "Loading…")).toBe("Загрузка…");
    expect(translateValue(DICT, "Settings:")).toBe("Настройки:");
    expect(translateValue(DICT, "Loading...")).toBe("Загрузка...");
  });

  it("переводит безопасные динамические подписи дополнений", () => {
    expect(translateValue(DICT, "Disable bb--composer")).toBe(
      "Отключить bb--composer",
    );
    expect(translateValue(DICT, "View details for ai-video-generation")).toBe(
      "Открыть сведения: ai-video-generation",
    );
    expect(translateValue(DICT, "Fork code-review into a new bb skill")).toBe(
      "Создать новый навык bb из code-review",
    );
    expect(
      translateValue(
        DICT,
        "Installed at C:\\Users\\deicer\\.bb\\bin\\bb.cmd. You can control bb from any terminal, and so can agents outside bb, such as Claude Code or Codex.",
      ),
    ).toBe(
      "Установлено: C:\\Users\\deicer\\.bb\\bin\\bb.cmd. Управлять bb можно из любого терминала, как и из внешних агентов, например Claude Code или Codex.",
    );
    expect(translateValue(DICT, "Installed on 2 of 3 machines")).toBe(
      "Установлено на 2 из 3 машин",
    );
    expect(translateValue(DICT, "to see available devices.")).toBe(
      "чтобы увидеть доступные устройства.",
    );
  });

  it("молчит о том, чего в словаре нет", () => {
    expect(translateValue(DICT, "Unknown label")).toBeNull();
    // Фраза человека, а не подпись кнопки: точного совпадения нет.
    expect(translateValue(DICT, "Open the settings for me")).toBeNull();
  });

  it("не делает пустую работу, когда перевод равен оригиналу", () => {
    expect(translateValue(DICT, "Same")).toBeNull();
  });

  it("не трогает пустые и пробельные узлы", () => {
    expect(translateValue(DICT, "")).toBeNull();
    expect(translateValue(DICT, "\n  ")).toBeNull();
  });
});

describe("missingKey", () => {
  it("возвращает ключ для неизвестной подписи", () => {
    expect(missingKey(DICT, "  Merge base ")).toBe("Merge base");
  });

  it("не считает пропуском то, что уже переведено", () => {
    expect(missingKey(DICT, "Settings")).toBeNull();
  });

  it("не собирает мусор из одиночных символов и цифр", () => {
    expect(missingKey(DICT, "7")).toBeNull();
    expect(missingKey(DICT, "· x")).toBeNull();
  });
});

describe("missingKey: отсев динамики", () => {
  it("не собирает подписи со счётчиками и разделителями", () => {
    expect(missingKey(DICT, "Codex · —% 5h · 10% wk")).toBeNull();
    expect(missingKey(DICT, "3 prototypes")).toBeNull();
  });

  it("не собирает подписи с подставленным русским текстом", () => {
    expect(missingKey(DICT, "Open Изучить код — Unread thread succeeded")).toBeNull();
  });

  it("но собирает обычную английскую подпись с горячей клавишей", () => {
    expect(missingKey(DICT, "Open new tab (Ctrl + T)")).toBe(
      "Open new tab (Ctrl + T)",
    );
  });
});

describe("missingKey: отсев идентификаторов", () => {
  it("не собирает пути и одинокие строчные слова", () => {
    expect(missingKey(DICT, "bb-plugin-ru/README.md")).toBeNull();
    expect(missingKey(DICT, "prototype")).toBeNull();
    expect(missingKey(DICT, "master")).toBeNull();
  });

  it("не собирает безопасные динамические подписи дополнений", () => {
    expect(missingKey(DICT, "Fork code-review into a new bb skill")).toBeNull();
    expect(missingKey(DICT, "Disable bb--composer")).toBeNull();
    expect(missingKey(DICT, "Installed on 2 of 3 machines")).toBeNull();
    expect(missingKey(DICT, "to see available devices.")).toBeNull();
  });

  it("но собирает нормальные подписи из нескольких слов", () => {
    expect(missingKey(DICT, "Reply in side chat")).toBe("Reply in side chat");
    expect(missingKey(DICT, "Filters")).toBe("Filters");
  });
});

describe("missingKey: дефис в обычном тексте", () => {
  it("собирает фразы со словами через дефис", () => {
    expect(missingKey(DICT, "Choose a built-in palette")).toBe(
      "Choose a built-in palette",
    );
    expect(missingKey(DICT, "third-party marketplace")).toBe(
      "third-party marketplace",
    );
  });

  it("но по-прежнему отсекает одинокий идентификатор", () => {
    expect(missingKey(DICT, "ai-avatar-video")).toBeNull();
  });
});
