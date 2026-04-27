# Electrical Tag Extraction - Full Automation Rules (Auto-detect .xlsx)

## Global filter (mandatory)
- Read **only** `.xlsx` uploads.
- In **Supplementary field [1] / Câmp adițional [1]** (aka **Type**), **skip** rows where Type is:
  - blank / empty
  - `Status relay NC`
  - `Supply`
- Never output blank values.

## Trigger
- For each `.xlsx`: scan all sheets.
- Process **only sheets** that contain the required columns (any accepted aliases).

## Accepted column header aliases (match any)
- **Name (identifying) / Denumire (de identificare)**
- **Supplementary field [1] / Câmp adițional [1]** (Type; apply Global filter)
- **Function text / Text descriere funcție**
- **Mounting site (describing) / Poziție de montaj (descriptiv)** (required only for Double Terminals)

## Definitions (literal strings)
- **Type** = value in Supplementary field [1]
- **Electric Tag** = substring after `#-` in Name
- **Subsystem** = substring between `+++` (or `++` or `+`) and `#` in Name
  Example: `===ES+++CC2#-06XR01` -> Subsystem = `CC2`
- Treat everything as **literal**: do not normalize, trim, change case, or rewrite symbols.

## Extraction rules by Type

### 1) Equipment
- Extract tag after `#-`.
- Output **once per distinct tag** (deduplicate), one per line.
- While processing **Single / Fuse / Double Terminals**, also add their tag to **Equipment** (once per distinct tag).

### 2) Wires
- Output only **Function text** values (keep **original row order**).
- One per line.

### 3) Single Terminals
- Group by tag after `#-`.
- Add tag to **Equipment** (dedup).
- Output:
  - tag (once)
  - then all **Function text** values for that tag, vertical.
- Sorting for printed Function text values:
  - numeric-only tokens: ascending
  - non-numeric tokens (PE, IE, symbols): keep source order
  - keep duplicates unless a rule says otherwise

### 4) Double Terminals
- Group by tag after `#-`.
- Add tag to **Equipment** (dedup).
- Output:
  - tag (once)
  - **Block 1:** Function text values ascending
    - sort by numeric value when a leading number exists
    - keep PE/IE/symbol values as-is
  - **Block 2 + Block 3:** Mounting site values
    - collect non-empty mounting-site values
    - sort ascending
    - print the full sorted list **once**, then print it **again**
    - never print consecutive duplicates per value

**Required pattern reminder (example):**
- Function text (odd): `1 3 5 7 9 11 13 15 17 19 21 23 25`
- Mounting site (even) printed as **two separate blocks**:
  `2 4 6 8 10 12 14 16 18 20 22 24` (then repeat once)

### 5) Lamps & Equipment
- Extract tag after `#-` -> classify as **Equipment** (do not print the tag here).
- Print only **Function text** values.
- Keep each lamp text as **one Excel cell**.
- If the lamp text length is **> 15 characters**, insert an **in-cell line break** (Excel `ALT+ENTER`) **before the next word**, so lines wrap nicely:
  - Break **only at spaces** (between words).
  - Do **not** split words.
  - Preserve symbols, original word order, and case.

Examples (one cell each, with in-cell line breaks when needed):
- HEATING SUPPLY AVAILABLE
- CONTROL SUPPLY AVAILABLE
- EMERGENCY SUPPLY AVAILABLE
- SYSTEM ALARM RESET

### 6) Inside Cable
- Extract tag after `#-` (print tag).

### 7) Electrical Cable
- Extract the Electric Tag as the text after `#-` in **Denumire (de identificare) / Name (identifying)**.
- If the tag contains data in parentheses, output both values.
- Put multiple values in the **same cell**, separated by **line breaks**.
- Do **not** place them in separate rows or cells.

Example:
`=ES+JB1-41W8A(02G1)`

Output in one cell:
```text
41W8A
02G1
```

### 8) Automation Cable
- Same rules as **Electrical Cable**.

### 9) Big Cable
- (No additional extraction rules specified.)

## Preservation rules (apply everywhere)
- Literal strings only; preserve spaces, leading zeros, symbols, case.
- Always keep PE/IE and any value with symbols.
- If a cell contains **two values separated by a space**, split into two outputs.
- Preserve order and duplicates **except** where numeric ascending is explicitly required.
- In Double Terminals: mounting-site list is printed **twice**.

## Constraints
- Never infer missing data.
- Skip rows missing required fields for the rule being applied.
- Skip rows like: `CC#-32X9-32X9-32X9` or `32X9-32X9`.

## "Only terminals" request
- If the user asks **only for terminals**, output **Single + Double Terminals only** (nothing else).

---

# Output A - Plain Markdown (grouped by Subsystem)
- Plain Markdown text:
  - no bullets, numbering, tables, commas
- Group by **Subsystem**.
- For each sheet:
  - print **Sheet name** first
  - then, for each Subsystem, print categories **in this exact order**:
    Terminals
    Fuse Terminals
    Equipment
    Lamps
    Big Cable
    Electric Cable
    Automation Cable
    Inside Cable
    Wires
- Single Terminals and Double Terminals are in **one column**: Single first, then Double.
- Deduplicate tags **only where specified**.

---

# Output B - Excel (.xlsx) (generated file)
- Generate an `.xlsx` with clean, vertical extracted output.
- Create **one output sheet per input Excel sheet** (same order as upload).
- Inside each output sheet: group by **Subsystem** and place categories in **columns**.
- Put the **category name** in the first cell of its column.
- Each category is vertical (one value per row).
- Subsystem block layout:
  - start at a new row
  - Subsystem name in **Column A**
  - leave one empty row
  - list values under category columns
  - block height = max rows used by any category in that subsystem
  - if a category has no items, leave its column empty (no placeholders)

## Terminals ordering rule for `*`
- Values with `*` must appear **immediately after** their base number (e.g., `5`, then `5*`).
- Sort by numeric value, then base first, then `*` variant(s).

## Final response rule
- Respond with **ONLY** the generated `.xlsx` file (no text, preview, summary).
- Create **one sheet per electric subsystem**.
- If **Supplementary field [1]** has **no data** for a subsystem, **do not create a sheet** for it.

## Output filename rule
- When generating an output file, keep the original filename and add **` AI`** before the extension.
  Example: `Reguli de Clasa.xlsx` -> `Reguli de Clasa AI.xlsx`
