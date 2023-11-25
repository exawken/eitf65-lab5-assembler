// Run this file using: deno run -- input.txt [output.hex]
//
// Each line in the input file can be:
//
// - A label like :main
// - Empty
// - An instruction like ADD R0 000 0001
// - An attribute like @define or @no_default_ops
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
//
// The assembler also supports customizing the defined operations using syntax
// like:
// @define OP_NAME reg=always|never|optional data=none|binary|address [unconditional-jump] => OPCODE_1 [no-reg] [no-data], OPCODE_2, OPCODE_3
// For example:
// @define CALL reg=never data=address => 0
// OR:
// @define WRITE reg=optional data=binary => 6, 8 no-data
//
// The @no_default_ops attribute might also be useful in such cases to ensure no
// default operations remain loaded.

const isDeno = 'Deno' in window;

export class ErrorWithCause extends Error {
    constructor(message: string, options: { cause?: unknown }) {
        if (!isDeno && options.cause) {
            message += "\nCaused by: " + String(options.cause);
        }
        super(message, options);
    }
}

/** An instruction as represented by the "FPGA_ROM_Editor.exe" program. */
export class Instruction {
    public constructor(
        private _opcode: number, private _r1: boolean, private _data: number, public comment: string
    ) {
        if (_data > 0b0111_1111) throw new Error(`Instruction data can't be more than 7 bits but was ${_data.toString(2)}`);
        if (_opcode > 0b1111) throw new Error(`Opcode can't be more than 4 bits but was ${_opcode.toString(2)}`);
    }
    get opcode() {
        return this._opcode;
    }
    get r1() {
        return this._r1;
    }
    get data() {
        return this._data;
    }
    toString() {
        const { opcode, r1, data, comment } = this;
        // Note: even though the data field can't contain more than 7 bits in
        // the actual hardware the ROM editor reserves 8 bits for its value.
        return (opcode << 9 | (+r1) << 8 | data).toString(16).padStart(4, '0') + ';' + comment;
    }
}

export const operationRegValues = ['never', 'optional', 'always'] as const;
export const operationDataValues = ['address', 'binary', 'none'] as const;
export type OperationReg = (typeof operationRegValues)[number];
export type OperationData = (typeof operationDataValues)[number];
export function isOperationReg(text: string): text is OperationReg {
    return (operationRegValues as readonly string[]).includes(text);
}
export function isOperationData(text: string): text is OperationData {
    return (operationDataValues as readonly string[]).includes(text);
}
export type OperationOutput = {
    opcode: number,
    useRegister?: boolean,
    useData?: boolean,
};
/*** A known assembly instruction. */
export class Operation {
    public constructor(
        public op: string,
        public reg: OperationReg,
        public data: OperationData,
        public alwaysBranches: boolean,
        public output: OperationOutput[]
    ) { }

    public static parse(text: string) {
        text = text.trim();
        if (!text) throw new Error(`Could not parse <empty string> as an operation`);

        const opIx = text.indexOf(' ');
        if (opIx < 0) throw new Error(`Expected register info " reg=..." after operation name "${text}"`);
        const op = text.slice(0, opIx);
        text = text.slice(opIx + 1).trimStart();

        const regIx = text.indexOf(' ');
        if (regIx < 0) throw new Error(`Expected data info " data=...." after register info`);
        let reg = text.slice(0, regIx);
        text = text.slice(regIx + 1).trimStart();
        if (!reg.startsWith('reg'))
            throw new Error(`Expected register info to start with "reg=" but found "${reg}"`);
        reg = reg.slice('reg'.length).trimStart();
        if (!reg.startsWith('='))
            throw new Error(`Expected register info to start with "reg=" but found no "="`);
        reg = reg.slice('='.length).trimStart();
        if (!isOperationReg(reg))
            throw new Error(`Expected one of ${operationRegValues.join(', ')} after "reg="`);


        const dataIx = text.indexOf(' ');
        let data = text;
        if (dataIx >= 0) {
            data = text.slice(0, dataIx);
            text = text.slice(dataIx + 1).trimStart();
        } else {
            text = '';
        }
        if (!data.startsWith('data'))
            throw new Error(`Expected data info to start with "data=" but found "${data}"`);
        data = data.slice('data'.length).trimStart();
        if (!data.startsWith('='))
            throw new Error(`Expected data info to start with "data=" but found no "="`);
        data = data.slice('='.length).trimStart();
        if (!isOperationData(data))
            throw new Error(`Expected one of ${operationDataValues.join(', ')} after "data="`);

        const unreachableFlag = 'unconditional-jump';
        const unreachable = text.startsWith(unreachableFlag);
        if (unreachable) text = text.slice(unreachableFlag.length).trimStart();

        const output: OperationOutput[] = [];
        if (text) {
            if (!text.startsWith('=>'))
                throw new Error(`Expected arrow "=>" after operation definition before output instructions`);
            text = text.slice('=>'.length).trimStart();

            const noRegFlag = 'no-reg';
            const noDataFlag = 'no-data';

            for (const outputStr of text.split(',')) {
                const [opcodeStr, ...options] = outputStr.split(' ').filter(v => v);
                const opcode = Number(opcodeStr);
                if (isNaN(opcode)) {
                    throw new Error(`Failed to parse ${opcodeStr} as number to use as opcode`);
                }
                const entry: OperationOutput = { opcode, useRegister: true, useData: true, };
                output.push(entry);
                for (let i = 0; i < options.length; i++) {
                    if (options[i] === noRegFlag) {
                        entry.useRegister = false;
                    } else if (options[i] === noDataFlag) {
                        entry.useData = false;
                    } else {
                        throw new Error(`Invalid modifier #${i + 1} "${options[i]}" for output opcode "${opcodeStr}", if this was expected to be a new opcode then add a comma (,) before it`);
                    }
                }
            }
        }

        return new Operation(op, reg, data, unreachable, output);
    }
}

export const knownRegisters = ['R0', 'R1'] as const;
export const knownRegistersUntyped: readonly string[] = knownRegisters;
export type Reg = (typeof knownRegisters)[number]
export function isReg(text: string): text is Reg {
    return knownRegistersUntyped.includes(text);
}

export type ParseOptions = {
    supportedOps?: Operation[],
    /** Always parse the data part of certain instructions as binary numbers. */
    expectBinaryData?: (opcode: string) => boolean,
    /** If specified then only certain item types will be parsed, the rest will
     * be skipped. Useful to handle preprocessor items. */
    parseItemTypes?: Partial<Record<Item['type'], boolean>>,
}

export class Line {
    private constructor(
        public line: string,
        public uncommentedLine: string,
        public item?: Item,
        public comment?: string,
        public secretComment?: string,
    ) { }

    static parse(line: string, options?: ParseOptions): Line {
        let text = line;
        // Parse "secret" comments (not emitted in output file):
        const secretIx = text.indexOf('#');
        let secretComment: string | undefined;
        if (secretIx >= 0) {
            secretComment = text.slice(secretIx + '#'.length);
            text = text.slice(0, secretIx);
        }

        // Parse "public" comment that will be included in the output file:
        const commentIx = text.indexOf('//');
        let comment: string | undefined;
        if (commentIx >= 0) {
            comment = text.slice(commentIx + '//'.length);
            text = text.slice(0, commentIx);
        }

        text = text.trim();

        const canParse = (key: Item['type']) => !(options?.parseItemTypes) || options.parseItemTypes[key];
        let item: Item | undefined;
        if (text.startsWith('@')) {
            if (canParse('attribute')) {
                item = {
                    type: 'attribute',
                    content: text.slice('@'.length),
                };
                if (text.startsWith('@define')) {
                    item.op = Operation.parse(text.slice('@define'.length));
                } else if (text.toLowerCase() === '@no_default_ops') {
                    item.no_default_ops = true;
                } else {
                    throw new Error(`Expected @define or @no_default_ops but found "${text}"`);
                }
            }
        } else if (text.startsWith(':')) {
            if (canParse('label')) {
                const jumpLabel = text.slice(1);
                if (jumpLabel.includes(' ')) {
                    throw new Error(`Labels can't contain spaces but found the label "${text}"`);
                }
                item = {
                    type: 'label',
                    name: jumpLabel,
                };
            }
        } else if (text && canParse('statement')) {
            // Parse statement:
            item = parseStatement(text, options);
        }


        return new Line(line, text, item, comment, secretComment);
    }
}
export type Item =
    | Statement
    | Label
    | Attribute;

export type Attribute = {
    type: 'attribute',
    content: string,
    op?: Operation,
    no_default_ops?: true,
};

export type Label = {
    type: 'label',
    name: string,
};

export type Statement = {
    type: 'statement',
    op: string,
    reg?: Reg,
    data?: number,
    jumpLabel?: string,
}

function parseStatement(text: string, options?: ParseOptions): Statement {
    // Parse opcode:
    text = text.trim();
    const afterOpIx = text.indexOf(' ');
    if (afterOpIx < 0) return { type: 'statement', op: text };
    const op = text.slice(0, afterOpIx).trimEnd();
    text = text.slice(afterOpIx).trimStart();

    // Parse registers:
    let reg: undefined | Reg;
    for (const knownReg of knownRegisters) {
        if (!text.startsWith(knownReg)) continue;
        reg = knownReg;
        text = text.slice(knownReg.length).trimStart();
        break;
    }

    // Parse jump label:
    let jumpLabel: string | undefined;
    if (text.startsWith(':')) {
        jumpLabel = text.slice(1);
        if (jumpLabel.includes(' ')) {
            throw new Error(`Labels can't contain spaces but found the label "${text}"`);
        }
        text = '';
    }

    // Parse data:
    let data: number | undefined;
    if (text) {
        let isBinary = false;
        if (options?.supportedOps) {
            for (const operation of options?.supportedOps) {
                if (operation.op.toUpperCase() !== op.toUpperCase()) continue;
                isBinary = operation.data === 'binary';
                break;
            }
        } else if (options?.expectBinaryData) {
            isBinary = options.expectBinaryData(op);
        }

        const joinedText = text.replaceAll(' ', '');
        // https://byby.dev/js-binary-to-decimal
        data = Number((isBinary ? '0b' : '') + joinedText);
        if (isNaN(data)) {
            if (text.toLowerCase().startsWith('r')) {
                throw new Error(`This instruction didn't expect a register`);
            }
            throw new Error(`Failed to parse ${text} as a ${isBinary ? 'binary ' : ''}number`);
        }
    }
    return { type: 'statement', op, reg, data, jumpLabel };
}

export type EmitOptions = {
    emitWarning?: (msg: string, lineIndex: number) => void,
};
type ProgramProcessOptions = {
    resolveLabels: boolean,
    validateInstructionArgs: boolean,
} & EmitOptions;

const defaultOps = `
CALL reg=never data=address => 0
RET reg=never data=none unconditional-jump => 1
BZ reg=always data=address => 2
B reg=never data=address unconditional-jump => 3
ADD reg=always data=binary => 4
SUB reg=always data=binary => 5
LD reg=always data=binary => 6
IN reg=always data=none => 7
OUT reg=always data=none => 8
AND reg=always data=binary => 9
WRITE reg=optional data=binary => 6, 8 no-data
`.split('\n').filter(l => l).map((line, ix) => {
    try {
        return Operation.parse(line)
    } catch (error) {
        throw new ErrorWithCause(`Failed to parse default op from line ${ix + 1} with content "${line}"`, { cause: error });
    }
});

export class Program {
    private labels: Map<string, number> | null = null;
    public ops: Map<string, Operation> = new Map();

    private constructor(
        public lines: Line[],
    ) { }

    public setOps(ops: Operation[]) {
        this.ops = new Map(ops.map(op => [op.op.toUpperCase(), op]));
    }

    public static parse(content: string, options?: ParseOptions): Program {
        return new Program(content.replaceAll('\r', '').split('\n').map((line, ix) => {
            try {
                return Line.parse(line, options);
            } catch (error) {
                throw new ErrorWithCause(`Syntax error at line ${ix + 1} with content "${line}"`, { cause: error });
            }
        }));
    }

    private _process(options: ProgramProcessOptions): Instruction[] {
        const instructions: Instruction[] = [];
        let unreachable = false;
        for (let i = 0; i < this.lines.length; i++) {
            try {
                const line = this.lines[i];
                if (line.item === undefined) continue;
                switch (line.item.type) {
                    case 'label': {
                        unreachable = false;
                        if (!options.resolveLabels) continue;
                        const label = line.item.name;
                        if (this.labels?.has(label)) {
                            throw new Error(`Label "${label}" was defined multiple times`);
                        }
                        this.labels?.set(label, instructions.length);
                    } break;
                    case 'statement': {
                        if (line.item.jumpLabel) {
                            const address = this.labels?.get(line.item.jumpLabel);
                            if (address !== undefined) {
                                line.item.data = address;
                            } else if (options.validateInstructionArgs) {
                                throw new Error(`Label "${line.item.jumpLabel}" was never defined`);
                            }
                        }
                        const op = this.ops.get(line.item.op.toUpperCase());
                        if (op === undefined) throw new Error(`Unknown operation "${line.item.op}"`);
                        if (options.validateInstructionArgs) {
                            // Validate parsed data
                            switch (op.reg) {
                                case 'always':
                                    if (line.item.reg === undefined) throw new Error(`Must specify register using R0 or R1`);
                                    break;
                                case 'never':
                                    if (line.item.reg !== undefined) throw new Error(`Can't specify a register for this operation, remove "${line.item.reg}"`);
                                    break;
                                case 'optional':
                                    break;
                                default: {
                                    const _exhaustive: never = op.reg;
                                }
                            }
                            switch (op.data) {
                                case 'address':
                                    if (line.item.data === undefined)
                                        throw new Error(`This instruction requires a target address`);
                                    if (!line.item.jumpLabel && !unreachable) {
                                        options?.emitWarning?.(`branching to hard coded address ${line.item.data}`, i);
                                    }
                                    break;
                                case 'binary':
                                    if (line.item.data === undefined)
                                        throw new Error(`This instruction requires a binary value`);
                                    break;
                                case 'none':
                                    break;
                                default: {
                                    const _exhaustive: never = op.data;
                                }
                            }
                        }
                        let labelComment = '';
                        if (this.labels) {
                            for (const [label, target] of this.labels) {
                                if (instructions.length === target) {
                                    labelComment += ':' + label.replaceAll(' ', '_') + ' ';
                                }
                            }
                        }
                        const comment = (line.comment ?? '') + (line.comment ? ' ' : '') + `(Assembly: ${labelComment}${line.uncommentedLine})`;
                        for (const out of op.output) {
                            instructions.push(new Instruction(
                                out.opcode,
                                out.useRegister ? (line.item.reg === 'R1') : false,
                                out.useData ? (line.item.data ?? 0) : 0,
                                comment
                            ));
                        }
                        if (op.alwaysBranches) unreachable = true;
                    } break;
                    case 'attribute': {
                        if (line.item.no_default_ops) {
                            for (const op of defaultOps) {
                                if (this.ops.get(op.op.toUpperCase()) === op) {
                                    this.ops.delete(op.op.toUpperCase());
                                }
                            }
                        }
                        if (line.item.op) {
                            this.ops.set(line.item.op.op, line.item.op);
                        }
                    } break;
                    default: {
                        const _exhaustive: never = line.item;
                    }
                }
            } catch (error) {
                throw new ErrorWithCause(`Failed to emit instruction for line ${i + 1} in assembly file with content:\n\t${this.lines[i].line}`, { cause: error });
            }
        }
        return instructions;
    }


    public loadDefinedOps() {
        this._process({ resolveLabels: false, validateInstructionArgs: false });
    }

    public resolveLabels() {
        if (this.labels) return;

        this.labels = new Map();
        this._process({ resolveLabels: true, validateInstructionArgs: false });
    }

    public emit(options?: EmitOptions): string {
        if (!this.labels) {
            throw new Error(`Generate labels before emitting instructions`);
        }
        const instructions = this._process({ ...options, resolveLabels: false, validateInstructionArgs: true });

        // pad until there are 64 instructions:
        let address = instructions.length;
        let out = instructions.map(inst => inst.toString() + '\n').join('');
        while (address < 64) {
            out += '0000;\n';
            address++;
        }
        return out;
    }
}

type AssembleOptions = {
    emitWarning?: (msg: string, lineIndex: number) => void
};

export function assemble(content: string, options?: AssembleOptions): string {
    const attributes = Program.parse(content, { parseItemTypes: { attribute: true } });
    attributes.setOps(defaultOps);
    attributes.loadDefinedOps();
    const supportedOps = Array.from(attributes.ops.values());

    const prog = Program.parse(content, { supportedOps });
    prog.setOps(supportedOps);
    prog.resolveLabels();
    return prog.emit(options);
}

// @ts-ignore
if (isDeno && import.meta.main) {
    if (!Deno.args[1]) {
        throw new Error(`Expected at least one argument`)
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
