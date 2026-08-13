// Reads back the file core.exportCsv wrote.
//
// The fixture tests used to assert on the argument handed to XLSX.utils.json_to_sheet, which is
// the row objects the crawler built - one step short of the file. A CSV has no such seam: the
// only thing worth asserting on is the text that lands on disk, so the tests capture the Blob and
// parse it back. That is strictly the better check anyway, because it also fails when a comma in
// a company name or a newline in a Positions cell shifts a column.

// A full RFC 4180 reader, because the crawler writes all three of the hard cases: a quote inside
// a quoted field, a comma inside one, and a newline inside one.
function parseCsv(text) {

    const source = String(text).replace(new RegExp("^" + String.fromCharCode(0xFEFF)), "");

    const rows = [];

    let row = [];
    let field = "";
    let quoted = false;
    let started = false;

    for (let i = 0; i < source.length; i++) {

        const ch = source[i];

        if (quoted) {

            if (ch !== '"') { field += ch; continue; }

            // "" inside a quoted field is one literal quote
            if (source[i + 1] === '"') { field += '"'; i++; continue; }

            quoted = false;
            continue;

        }

        if (ch === '"') { quoted = true; started = true; continue; }

        if (ch === ",") { row.push(field); field = ""; started = true; continue; }

        if (ch === "\r") continue;

        if (ch === "\n") {
            row.push(field);
            rows.push(row);
            row = [];
            field = "";
            started = false;
            continue;
        }

        field += ch;
        started = true;

    }

    if (started || field.length) { row.push(field); rows.push(row); }

    if (!rows.length) return [];

    const headers = rows[0];

    return rows.slice(1).map(cells => {

        const out = {};

        headers.forEach((header, at) => { out[header] = cells[at] === undefined ? "" : cells[at]; });

        return out;

    });

}

module.exports = { parseCsv };
