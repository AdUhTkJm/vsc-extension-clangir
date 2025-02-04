// A very basic language server that only calculates semantic tokens.

import * as lsp from 'vscode-languageserver/node';
import * as doc from 'vscode-languageserver-textdocument';
import { types } from 'util';

const typenames = [
	"dense", "vector",
];

const keywords = [
	"loc", "module",
	"nsw", "nuw",
	"extra", "const",
];

const macros = [
	"fused", "undefined", "async", "init",
	"constant", "dsolocal", "private", "cir_private",
	"attributes", "struct", "incomplete",
	"true", "false",
];

const tokenTypesLegend = [
	"keyword", "function", "variable", "number",
	"comment", "type", "macro", "operator",
	"namespace", "string", "enumMember",
];
const tokenModifiersLegend = ["declaration", "readonly", "deprecated"];

const tokenTypes: { [x: string]: number } = {};
const tokenModifiers: { [x: string]: number } = {};

// Initialize
tokenTypesLegend.forEach((x, i) => tokenTypes[x] = i);
tokenModifiersLegend.forEach((x, i) => tokenModifiers[x] = i);

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = lsp.createConnection(lsp.ProposedFeatures.all);
const documents = new lsp.TextDocuments(doc.TextDocument);

let hasCompletion = false;

connection.onInitialize((params: lsp.InitializeParams) => {
	const capabilities = params.capabilities;

	hasCompletion = !!capabilities.textDocument?.completion;

	const result: lsp.InitializeResult = {
		capabilities: {
			textDocumentSync: lsp.TextDocumentSyncKind.Incremental,
			semanticTokensProvider: {
				legend: {
					tokenTypes: tokenTypesLegend,
					tokenModifiers: tokenModifiersLegend,
				},
				range: false,
				full: {
					delta: true
				}
			},
		}
	};
	
	return result;
});

const prevTokens = new Map<string, number[]>();

class Token {
	line_no: number;
	start: number;
	type: number;
	modif: number;
	value: string;

	constructor(line_no: number, start: number, value: string, type: number, modif: number) {
		this.line_no = line_no;
		this.start = start;
		this.value = value;
		this.type = type;
		this.modif = modif;
	}

	length() { return this.value.length; }
}

function splitLine(tokens: Token[]): Token[][] {
	// Split each line.
	let lines: Token[][] = [];
	let curInst: Token[] = [];
	let curLine = -1;
	for (let x of tokens) {
		if (x.line_no !== curLine) {
			curLine = x.line_no;
			if (curInst.length > 0) {
				lines.push(curInst);
				curInst = [];
			}
		}

		// Remove comments.
		if (x.type !== tokenTypes.comment)
			curInst.push(x);
	}
	// The final push is not done yet, do it now
	if (tokens.length > 0)
		lines.push(curInst);

	return lines;
}

function computeSemanticTokens(uri: string) {
	const text = documents.get(uri)?.getText()!;

	let tokens: Token[] = [];
	let lines = text.split("\n");

	// We implement a small tokenizer.
	lines.forEach((line, line_no) => {
        let i = 0;
        while (i < line.length) {
            let remains = line.slice(i);
			let x = remains.charAt(0);

			// type
			if (x === "!") {
				let next = remains.match(/^!(?:cir\.|llvm\.)?\w+/);
				if (next) {
					let str = next[0];
					tokens.push(new Token(line_no, i, str, tokenTypes.type, 0));
					i += str.length;
				}
				continue;
			}

			// string
			if (x === "\"") {
				let j = i + 1;
				while (j < line.length) {
					if (line.charAt(j) === "\"") {
						let backslash = 0;
						let k = j - 1;
						while (k >= i && line.charAt(k) === "\\")
							backslash++, k--;
						
						// Even number of backslashes means a valid string terminator
						if (backslash % 2 === 0)
							break;
					}
					j++;
				}
			
				tokens.push(new Token(line_no, i, line.slice(i, j + 1), tokenTypes.string, 0));
			
				i = j + 1;
				continue;
			}

            // number
            let matchImm = remains.match(/^\d+/);
            if (matchImm) {
                let str = matchImm[0];
                tokens.push(new Token(line_no, i, str, tokenTypes.number, 0));
                i += str.length;
                continue;
            }

			// cir operations
			let matchOp = remains.match(/^cir\.\w+/);
			if (matchOp) {
                let str = matchOp[0];
                tokens.push(new Token(line_no, i, "cir", tokenTypes.namespace, 0));
				tokens.push(new Token(line_no, i + 4, str.slice(4), tokenTypes.function, 0));
                i += str.length;
                continue;
			}

            // identifier
            let matchId = remains.match(/^[@%#](?:cir\.)?[_\w\d]+/);
            if (matchId) {
                let str = matchId[0];
				let first = str.charAt(0);

				let mapping: { [s: string]: number } = {
					"@": tokenTypes.function,
					"#": tokenTypes.enumMember,
					"%": tokenTypes.variable,
				};

				tokens.push(new Token(line_no, i, str, mapping[first], 0));
                i += str.length;
                continue;
            }

			// special words
			let matchSpecial = remains.match(/^\w+/);
            if (matchSpecial) {
                let str = matchSpecial[0];
				let type: number;

				if (keywords.includes(str))
					type = tokenTypes.keyword;
				else if (macros.includes(str))
					type = tokenTypes.macro;
				else if (typenames.includes(str))
					type = tokenTypes.type;
				else
					type = -1;

				tokens.push(new Token(line_no, i, str, type, 0));
                i += str.length;
                continue;
            }

            // Unrecognized character, just skip
            i++;
        }
	});
	
	// we must convert them to relative position.
	// the original array is already sorted according to (line, char_start).
	let currentLine = 0;
	let currentChar = 0;

	let relative = [];

	for (let x of tokens) {
		let deltaLine = x.line_no - currentLine;
		if (deltaLine > 0) {
			currentLine = x.line_no;
			currentChar = 0;
		}

		let deltaStart = x.start - currentChar;
		currentChar = x.start;

		relative.push(deltaLine, deltaStart, x.value.length, x.type, x.modif);
	}
	return relative;
}

function computeTokenDelta(before: number[], after: number[]) {
	let edits = [];

    // find the first mismatch index
    let minLen = Math.min(before.length, after.length);
    let mismatch = 0;
    while (mismatch < minLen && before[mismatch] === after[mismatch])
        mismatch++;

    // everything the same; no delta
    if (mismatch === before.length && mismatch === after.length)
        return [];

    // find the last mismatch index
    let beforeEnd = before.length;
    let afterEnd = after.length;
    while (beforeEnd > mismatch && afterEnd > mismatch && before[beforeEnd - 1] === after[afterEnd - 1])
        beforeEnd--, afterEnd--;

    // replace the tokens
    edits.push({
        start: mismatch,
        deleteCount: beforeEnd - mismatch,
        data: after.slice(mismatch, afterEnd)
    });

    return edits;
}

connection.languages.semanticTokens.on((params: lsp.SemanticTokensParams) => {
	const uri = params.textDocument.uri;
    const tokens = computeSemanticTokens(uri);
    prevTokens.set(uri, tokens);
    return { data: tokens };
});

connection.languages.semanticTokens.onDelta((params: lsp.SemanticTokensDeltaParams) => {
    const uri = params.textDocument.uri;
    const before = prevTokens.get(uri) ?? [];
    const after = computeSemanticTokens(uri);

    const delta = computeTokenDelta(before, after);

    prevTokens.set(uri, after);

    return { edits: delta };
});

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
