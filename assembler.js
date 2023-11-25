// Run this file using: deno run -- input.txt [output.hex] Each line in the
// input file can be:
//
// - A label like :main
// - Empty
// - An instruction like ADD R0 000 0001
//
// each of the above can end with a # character followed by a comment. If
// instead // is used for the comment then it will be emitted with the
// instruction on the same line.
//
// Branch instruction use decimal numbers when specifying their target address
// but its better to use the label syntax like BZ R0 :main.
//
// Other instructions use binary number when specifying their data like:
// ADD R0 000 1000.
const isDeno = 'Deno' in window;
export class ErrorWithCause extends Error {
    constructor(message, options) {
        if (!isDeno && options.cause) {
            message += "\nCaused by: " + String(options.cause);
        }
        super(message, options);
    }
}
export class InvalidInstructionError extends ErrorWithCause {
    constructor(lines, ix, parseError) {
        super(`Failed to emit instruction for line ${ix + 1} in assembly file with content:\n\t${lines[ix]}`, { cause: parseError });
        this.name = this.constructor.name;
    }
}
function splitOnce(text, separator, trimAfter) {
    const ix = text.indexOf(separator);
    if (ix < 0) {
        return [text, ''];
    }
    else {
        const result = [text.slice(0, ix), text.slice(ix + separator.length)];
        if (trimAfter) {
            return [result[0].trim(), result[1].trim()];
        }
        else {
            return result;
        }
    }
}
export function assemble(content, options) {
    let labels = options?._labels;
    const lines = content.replaceAll('\r', '').split('\n');
    let out = '';
    let address = 0;
    const emit = (opcode, r1, data, comment) => {
        if (data > 127)
            throw new Error(`Instruction data can't be more than 7 bits but was ${data.toString(2)}`);
        if (opcode > 0b1111)
            throw new Error(`Opcode can't be more than 4 bits but was ${opcode.toString(2)}`);
        out += (opcode << 9 | (+r1) << 8 | data).toString(16).padStart(4, '0') + ';' + comment + '\n';
        address++;
    };
    const generatingLabels = !labels;
    if (!labels) {
        labels = new Map();
    }
    let unreachable = false;
    const shouldWarn = () => !generatingLabels && !unreachable;
    for (let i = 0; i < lines.length; i++) {
        try {
            let line = lines[i];
            // Remove comments:
            [line,] = splitOnce(line, '#', false);
            let comment;
            [line, comment] = splitOnce(line, '//', false);
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            if (trimmed.startsWith(':')) {
                unreachable = false;
                if (!generatingLabels)
                    continue;
                const label = trimmed.slice(1).trim();
                if (labels.has(label)) {
                    throw new Error(`Label "${label}" was defined multiple times`);
                }
                labels.set(label, address);
                continue;
            }
            let labelComment = '';
            for (const [label, target] of labels) {
                if (address === target) {
                    labelComment += ':' + label.replaceAll(' ', '_') + ' ';
                }
            }
            comment += (comment ? ' ' : '') + `(Assembly: ${labelComment}${trimmed})`;
            let [op, args] = splitOnce(trimmed, ' ', true);
            const parseReg = () => {
                let regStr;
                [regStr, args] = splitOnce(args, ' ', true);
                if (!regStr.toUpperCase().startsWith('R'))
                    throw new Error(`Expected register name that starts with an R but found: ${regStr ? regStr : '<empty string>'}`);
                regStr = regStr.slice(1);
                const num = parseInt(regStr);
                if (isNaN(num)) {
                    throw new Error(`Failed to parse register number: "${regStr}"`);
                }
                if (num < 0 || 1 < num)
                    throw new Error(`There are only 2 registers, specify R0 or R1`);
                return num === 1;
            };
            const parseData = (binary) => {
                const text = args.replaceAll(' ', '');
                // https://byby.dev/js-binary-to-decimal
                const result = Number((binary ? '0b' : '') + text);
                if (isNaN(result)) {
                    if (text.toLowerCase().startsWith('r')) {
                        throw new Error(`This instruction didn't expect a register`);
                    }
                    throw new Error(`Failed to parse ${text} as a ${binary ? 'binary ' : ''}number`);
                }
                return result;
            };
            const parseLabel = () => {
                if (!args.startsWith(':')) {
                    // Assume a decimal address
                    const address = parseData(false);
                    if (shouldWarn()) {
                        options?.emitWarning?.(`branching to hard coded address ${address}`, i);
                    }
                    return address;
                }
                const label = args.slice(1).trim();
                if (generatingLabels)
                    return 0;
                const address = labels?.get(label);
                if (address === undefined) {
                    throw new Error(`Label "${label}" was never defined`);
                }
                return address;
            };
            const code = options?.opcodes?.[op.toUpperCase()];
            switch (op.toUpperCase()) {
                case 'CALL':
                    emit(code ?? 0, false, parseLabel(), comment);
                    break;
                case 'RET':
                    emit(code ?? 1, false, 0, comment);
                    unreachable = true;
                    break;
                case 'BZ':
                    emit(code ?? 2, parseReg(), parseLabel(), comment);
                    break;
                case 'B':
                    emit(code ?? 3, false, parseLabel(), comment);
                    unreachable = true;
                    break;
                case 'ADD':
                    emit(code ?? 4, parseReg(), parseData(true), comment);
                    break;
                case 'SUB':
                    emit(code ?? 5, parseReg(), parseData(true), comment);
                    break;
                case 'LD':
                    emit(code ?? 6, parseReg(), parseData(true), comment);
                    break;
                case 'IN':
                    emit(code ?? 7, parseReg(), 0, comment);
                    break;
                case 'OUT':
                    emit(code ?? 8, parseReg(), 0, comment);
                    break;
                case 'AND':
                    emit(code ?? 9, parseReg(), parseData(true), comment);
                    break;
                case 'WRITE':
                    // Emulate write instruction using R0 register
                    emit(options?.opcodes?.['LD'] ?? 6, false, parseData(true), comment);
                    emit(options?.opcodes?.['OUT'] ?? 8, false, 0, comment);
                    break;
                default:
                    throw new Error(`Unknown operation "${op}"`);
            }
        }
        catch (error) {
            throw new InvalidInstructionError(lines, i, error);
        }
    }
    while (address < 64) {
        out += '0000;\n';
        address++;
    }
    if (generatingLabels) {
        return assemble(content, { ...options, _labels: labels });
    }
    else {
        return out;
    }
}
if (isDeno && import.meta.main) {
    if (!Deno.args[1]) {
        throw new Error(`Expected at least one argument`);
    }
    let outPath = Deno.args[2];
    if (!outPath) {
        outPath = Deno.args[1];
        const extIx = outPath.lastIndexOf('.');
        if (extIx >= 0) {
            outPath = outPath.slice(0, extIx);
        }
    }
    const content = await Deno.readTextFile(Deno.args[1]);
    const hex = assemble(content, {
        emitWarning(msg, lineIx) {
            console.warn(`%cWARN: line ${lineIx + 1}: ${msg}`, 'color: yellow');
        },
    });
    if (!outPath.toLowerCase().endsWith('.hex')) {
        outPath += '.hex';
    }
    console.log(`Writing assembled file to: ${outPath}`);
    await Deno.writeTextFile(outPath, hex);
}
