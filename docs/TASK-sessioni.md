# SafeCant — Prossimi blocchi di lavoro

Annotazioni inter-sessione: temi di design e task emersi durante lo sviluppo,
da affrontare come progetti separati. Aggiornato man mano.

---

## BLOCCO: MULTI-CANTIERE (selezione del cantiere)

**Priorità**: dopo la chiusura dell'integrazione anagrafica v2.0 (entry point appbar + collaudo import)
**Origine**: emerso al collaudo del 3/6/2026 — il modello reale è diverso da quello attuale

### Il problema

Il modello implementato oggi in SafeCant è **1 ispettore = 1 cantiere (default fisso)**.
Il modello reale è **1 ispettore = N cantieri** (es. cantieri limitrofi seguiti dallo stesso CSE):
l'ispettore sceglie di volta in volta su quale cantiere sta facendo il sopralluogo.

L'attuale `cantiere_default` singolo nelle impostazioni non regge questo scenario.
Effetto collaterale del problema: se `cantiere_default` non è configurato e c'è più di un'anagrafica in IDB, il fallback non sa quale usare → `cantiereId` resta vuoto → doppio underscore nel nome file.

### Due lati gemelli da progettare insieme

**Lato SafeCant (ispettore)**
- Quando si avvia "Nuovo sopralluogo", mostrare un **selettore cantiere** (lista delle anagrafiche importate) invece di usare il default fisso.
- Scegliendo un'anagrafica reale il `cantiere_id` è sempre valorizzato — risolve alla radice il bug del doppio underscore senza workaround.
- Verificare lo stato attuale dell'IDB: `anagrafica_corrente` ha keyPath `cantiereId` e supporta già più record (uno per cantiere). La domanda è se SafeCant debba mostrare un selettore solo all'avvio del verbale o anche altrove (es. filtro nel cruscotto per cantiere).
- Valutare se rimuovere o ridimensionare il `cantiere_default` nelle impostazioni, o mantenerlo come "preferito" opzionale per chi lavora su un cantiere solo.

**Lato SafeHub (CSE/PO)**
- Oggi l'export anagrafica è uno alla volta (per cantiere).
- Se l'ispettore segue N cantieri, il PO deve esportarne N separatamente.
- Valutare: selezione multipla nell'export? Export "bundle multi-cantiere"? O semplicemente facilitare l'export rapido cantiere per cantiere?
- Il formato di scambio (un file JSON per cantiere) non deve necessariamente cambiare: è il flusso operativo di distribuzione che va ottimizzato.

### Vincoli di design noti

- Il file di interscambio verbale ha `metadati.cantiere_id` (singolo): il verbale è sempre per UN cantiere. Non cambia.
- SafeCant deve restare offline-first: il selettore cantiere deve lavorare su dati IDB locali, non richiedere rete.
- Se si cambia il momento di scelta del cantiere (da impostazioni a avvio verbale), va rivisto anche il sottotitolo appbar ("CZ400 — Sopralluoghi") che oggi dipende da `cantiere_default`.

### Status

**In attesa** — design non iniziato. Affrontare come progetto a sé dopo che:
1. L'integrazione anagrafica v2.0 è collaudata end-to-end (import → presenti Step 2 → NC Step 3 → verbale con cantiere_id corretto)
2. L'entry point Anagrafica nell'appbar è confermato funzionante

---
