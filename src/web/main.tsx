import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { LOCALE, LangContext, loadLang } from "./i18n.ts";

/** The root owns the page language (saved preference, else the browser's) and provides it; see docs/i18n.md. */
function Root() {
  const [lang, setLang] = useState(loadLang);
  useEffect(() => {
    document.documentElement.lang = LOCALE[lang];
  }, [lang]);
  return (
    <LangContext.Provider value={lang}>
      <App onLang={setLang} />
    </LangContext.Provider>
  );
}

createRoot(document.getElementById("root")!).render(<Root />);
