/* eslint-disable @stylistic/js/max-len */
import { pascalCase } from "es-toolkit"
import {
    type GraphQLArgument,
    type GraphQLEnumType,
    type GraphQLEnumValue,
    type GraphQLFieldMap,
    type GraphQLInputFieldMap,
    type GraphQLInputObjectType,
    type GraphQLInterfaceType,
    type GraphQLList,
    type GraphQLNamedType,
    type GraphQLNonNull,
    type GraphQLObjectType,
    type GraphQLScalarType,
    type GraphQLSchema,
    type GraphQLType,
    type GraphQLUnionType,
    isEnumType,
    isInputObjectType,
    isInterfaceType,
    isListType,
    isNonNullType,
    isObjectType,
    isScalarType,
    isUnionType
} from "graphql"

import { type ScalarMap, type UnicornConfig } from "./config"

export type TransformConfig = UnicornConfig

const AtomicScalars = {
    ID: "string",
    Int: "number",
    Float: "number",
    String: "string",
    Boolean: "boolean"
} satisfies ScalarMap

const RuntimeLib = "@gql-unicorn/runtime"

const Banner = [
    "/* eslint-disable */",
    "/* prettier-ignore */",
    "/* !!! GENERATED FILE DO NOT EDIT !!! */",
    'import * as __runtime from "@gql-unicorn/runtime"'
]

export function transform(schema: GraphQLSchema, config?: TransformConfig) {
    return new Transformer(schema, config || {}).transform()
}

const SelectTypeArgs = `R extends SelectionDef, V extends Vars, P extends string[]`

class Transformer {
    readonly #scalarMap: Record<string, string>
    readonly #typeMap: Record<string, string> = {}
    readonly #parts: string[] = []
    readonly #indent = "    "
    readonly #imports: Record<string, Record<string, boolean>> = {}
    readonly #argumentTypes: Record<string, string> = {}
    readonly #argumentInfosName: Record<string, string> = {}
    readonly #argumentInfos: string[] = []

    constructor(
        readonly schema: GraphQLSchema,
        readonly config: TransformConfig
    ) {
        // TODO: Support custom scalars
        this.#scalarMap = {
            ...AtomicScalars,
            ...this.config.scalars
        }
    }

    transform(): string {
        const builders: string[] = []

        const query = this.schema.getQueryType()
        if (query != null) {
            builders.push(...this.#rootBuilder(query, "query", "queryBuilder"))
        }

        const mutation = this.schema.getMutationType()
        if (mutation != null) {
            builders.push(...this.#rootBuilder(mutation, "mutate", "mutationBuilder"))
        }

        const subscription = this.schema.getSubscriptionType()
        if (subscription != null) {
            builders.push(...this.#rootBuilder(subscription, "subscribe", "subscriptionBuilder"))
        }

        const reexport = ["$", "$$"]
        this.#import(RuntimeLib, "TypeOf", true)
        this.#import(RuntimeLib, "VarOf", true)
        this.#import(RuntimeLib, "Selected", true)

        this.#parts.unshift(...Banner, ...this.#generateImports(), ...this.#argumentInfos)
        return [
            ...this.#parts,
            ...Object.values(this.#argumentTypes),
            ...builders,
            ...reexport.map(v => `export const ${v} = __runtime.${v}`),
            "export type { TypeOf, VarOf, Selected }"
        ].join("\n")
    }

    #generateImports(): string[] {
        return Object.entries(this.#imports).map(
            ([name, imports]) =>
                `import { ${Object.entries(imports)
                    .map(([name, isType]) => `${isType ? "type " : ""}${name}`)
                    .join(", ")} } from "${name}"`
        )
    }

    #addType(type: GraphQLNamedType): string {
        if (this.#typeMap[type.name]) {
            return this.#typeMap[type.name]
        }

        if (isScalarType(type)) {
            if (!(type.name in this.#scalarMap)) {
                throw new Error(`Unknown scalar type: ${type.name}`)
            }
            const name = this.#scalarMap[type.name]
            this.#typeMap[type.name] = name
            this.#parts.push(...this.#generateScalar(type, name))
            return name
        } else {
            const name = this.#bareType(type).name
            this.#typeMap[type.name] = name
            if (isEnumType(type)) {
                this.#parts.push(...this.#generateEnum(type, name))
            } else if (isInputObjectType(type)) {
                this.#parts.push(...this.#generateInput(type, name))
            } else if (isInterfaceType(type)) {
                this.#parts.push(...this.#generateInterface(type, name))
                this.#parts.push(...this.#select(type))
            } else if (isUnionType(type)) {
                this.#parts.push(...this.#generateUnion(type, name))
                this.#parts.push(...this.#select(type))
            } else if (isObjectType(type)) {
                this.#parts.push(...this.#generateObject(type, name))
                this.#parts.push(...this.#select(type))
            }
            return name
        }
    }

    #typename(type: GraphQLType, nullable: boolean = true): string {
        if (isListType(type)) {
            return this.#typenameOfList(type, nullable)
        } else if (isNonNullType(type)) {
            return this.#typenameOfNonNull(type)
        }

        return `${this.#addType(type)}${nullable ? " | null" : ""}`
    }

    #bareTypename(type: GraphQLType): string {
        return this.#addType(this.#bareType(type))
    }

    #selectName(type: GraphQLType): string {
        return `${this.#addType(this.#bareType(type))}Select`
    }

    #bareType(type: GraphQLType): GraphQLNamedType {
        if (isListType(type)) {
            return this.#bareType(type.ofType)
        } else if (isNonNullType(type)) {
            return this.#bareType(type.ofType)
        }
        return type
    }

    #typenameOfList(type: GraphQLList<GraphQLType>, nullable: boolean): string {
        return `Array<${this.#typename(type.ofType, nullable)}>`
    }

    #typenameOfNonNull(type: GraphQLNonNull<GraphQLType>): string {
        return this.#typename(type.ofType, false)
    }

    #generateScalar(_type: GraphQLScalarType, _name: string): string[] {
        return []
    }

    #generateEnum(type: GraphQLEnumType, name: string): string[] {
        return [
            ...this.#comment(type.description),
            `export const enum ${name} {`,
            ...this.#generateEnumValues(type.getValues()),
            "}"
        ]
    }

    #generateEnumValues(values: ReadonlyArray<GraphQLEnumValue>): string[] {
        const result = []
        const vl = values.length
        let i = 0
        for (const { name, value, description, deprecationReason } of values) {
            result.push(...this.#comment(description, deprecationReason).map(v => `${this.#indent}${v}`))
            result.push(`${this.#indent}${name} = ${JSON.stringify(value)}${i < vl - 1 ? "," : ""}`)
            ++i
        }

        return result
    }

    #generateObject(type: GraphQLObjectType, name: string): string[] {
        return [
            ...this.#comment(type.description),
            `export type ${name} = {`,
            `${this.#indent}__typename: ${JSON.stringify(this.#bareType(type).name)}`,
            ...this.#generateObjectFields(type, type.getFields()),
            `}`,
            ...this.#generateTypeBuilder(type)
        ].filter(Boolean)
    }

    #generateObjectFields(context: GraphQLType, fields: GraphQLFieldMap<any, any>): string[] {
        const result: string[] = []
        for (const [name, { type, description, deprecationReason }] of Object.entries(fields)) {
            result.push(
                ...this.#generateField(context, name, type, description, deprecationReason, null).map(
                    v => `${this.#indent}${v}`
                )
            )
        }
        return result
    }

    #generateTypeBuilder(context: GraphQLObjectType | GraphQLInterfaceType | GraphQLUnionType): string[] {
        this.#import(RuntimeLib, "TypeBuilder", true)
        const info: string[] = []

        if (!isUnionType(context)) {
            for (const { name, type, args } of Object.values(context.getFields())) {
                if (args.length > 0) {
                    const [_, ai] = this.#argumentsType(`${context.name}${pascalCase(name)}`, args)

                    if (bareIsScalar(type)) {
                        info.push(`${name}: ${ai}`)
                    } else {
                        info.push(`${name}: [${ai}, ${this.#bareTypename(type)}]`)
                    }
                } else {
                    if (!bareIsScalar(type)) {
                        info.push(`${name}: ${this.#bareTypename(type)}`)
                    }
                }
            }
        }

        const infoStr = info.length > 0 ? `, (() => ({ ${info.join(", ")} })) as () => __runtime.BuilderInfo` : ""
        const T = this.#selectType(this.#selectName(context), `["__typename"]`, "{}", "[]")
        const TN = JSON.stringify(context.name)
        return [
            `export const ${this.#bareTypename(context)} = __runtime.typeBuilder("${context.name}"${infoStr}) as TypeBuilder<${T}, ${TN}>`
        ]
    }

    #generateInput(type: GraphQLInputObjectType, name: string): string[] {
        return [
            ...this.#comment(type.description),
            `export type ${name} = {`,
            ...this.#generateInputFields(type.getFields()),
            `}`
        ]
    }

    #generateInputFields(fields: GraphQLInputFieldMap): string[] {
        const result: string[] = []
        for (const [name, { type, description, deprecationReason, defaultValue }] of Object.entries(fields)) {
            result.push(
                ...this.#generateField(null, name, type, description, deprecationReason, defaultValue).map(
                    v => `${this.#indent}${v}`
                )
            )
        }
        return result
    }

    #generateField(
        context: GraphQLType | null,
        name: string,
        type: GraphQLType,
        description?: string | null,
        deprecationReason?: string | null,
        defaultValue?: unknown
    ): string[] {
        const result: string[] = []
        result.push(...this.#comment(description, deprecationReason, defaultValue))

        if (isNonNullType(type)) {
            result.push(`${name}: ${this.#typename(type)}`)
        } else {
            result.push(`${name}: ${this.#typename(type)} | null`)
        }

        return result
    }

    #generateInterface(type: GraphQLInterfaceType, name: string): string[] {
        const types = this.#__typenames(type)
        const comment = this.#comment(type.description)
        return [...comment, `export type ${name} = ${types.join(" | ")}`, ...this.#generateTypeBuilder(type)]
    }

    #generateUnion(type: GraphQLUnionType, name: string): string[] {
        const types = this.#__typenames(type)

        return [
            ...this.#comment(type.description),
            `export type ${name} = ${types.join(" | ")}`,
            ...this.#generateTypeBuilder(type)
        ]
    }

    #rootBuilder(context: GraphQLObjectType, prefix: string, builder: string): string[] {
        const result: string[] = []

        for (const { name, args, type, description, deprecationReason } of Object.values(context.getFields())) {
            const varName = `${prefix}${pascalCase(name)}`
            const varType = `${pascalCase(prefix)}${pascalCase(name)}`
            let argType: string = "undefined"
            let argInfo: string | undefined
            let typeValue: string = "any"
            let builderT: string = "any"

            this.#import(RuntimeLib, "BuildReturn", true)

            if (args.length > 0) {
                ;[argType, argInfo] = this.#argumentsType(varType, args)
                if (bareIsScalar(type)) {
                    typeValue = this.#typename(type)
                    // <AA extends Arguments<A>>(...args: [string, AA] | [AA]): BuildReturn<T, {} & ToVars<A, [], AA>>
                    builderT =
                        `<AA extends Arguments<${argType}>>(...args: [string, AA] | [AA]) `
                        + `=> BuildReturn<${typeValue}, never, {} & ToVars<${argType}, [], AA>>`
                } else {
                    this.#import(RuntimeLib, "SelectionDef", true)

                    const R = this.#selectR(type)
                    typeValue = this.#selectType(this.#selectName(type), R, "{}", "[]")
                    argInfo = `[${argInfo}, ${this.#bareTypename(type)}]`
                    const sfn = `(select: ${typeValue}) => Selection<any, SS, SV>`
                    builderT =
                        `<SS extends SelectionDef, SV extends Vars, AA extends Arguments<${argType}>>`
                        + `(...args: [string, AA, ${sfn}] | [AA, ${sfn}]) `
                        + `=> BuildReturn<${this.#typename(type)}, SS, SV & ToVars<${argType}, [], AA>>`
                }
            } else {
                if (bareIsScalar(type)) {
                    typeValue = this.#typename(type)
                    builderT = `(name?: string) => BuildReturn<${typeValue}, never, never>`
                } else {
                    this.#import(RuntimeLib, "SelectionDef", true)

                    // const R = this.#rootBuilderResult(type)
                    const R = this.#selectR(type)
                    typeValue = this.#selectType(this.#selectName(type), R, "{}", "[]")
                    argInfo = this.#bareTypename(type)
                    const sfn = `(select: ${typeValue}) => Selection<any, SS, SV>`
                    builderT =
                        `<SS extends SelectionDef, SV extends Vars, >`
                        + `(...args: [string, ${sfn}] | [${sfn}])`
                        + `=> BuildReturn<${this.#typename(type)}, SS, SV>`
                }
            }

            const argInfoRes = argInfo ? `, ${argInfo}` : ""
            result.push(
                ...this.#comment(description, deprecationReason),
                `export const ${varName} = __runtime.${builder}("${name}"${argInfoRes}) as ${builderT}`
            )
        }

        return result
    }

    #select(type: GraphQLObjectType | GraphQLInterfaceType | GraphQLUnionType): string[] {
        const result: string[] = []

        this.#import(RuntimeLib, "Vars", true)
        this.#import(RuntimeLib, "Selection", true)

        const fields = isUnionType(type) ? [] : this.#selectFields(type, type.getFields())

        fields.push(...this.#onFns(type))

        // const R = isObjectType(type) ? `[...R, "__typename"]` : "R"
        result.push(
            ...this.#comment(type.description),
            `export interface ${this.#selectName(type)}<${SelectTypeArgs}> `
                + `extends Selection<${this.#bareTypename(type)}, R, V> {`,
            ...fields.map(v => `${this.#indent}${v}`),
            `}`
        )

        return result
    }

    #selectFields(context: GraphQLType, fields: GraphQLFieldMap<any, any>): string[] {
        const result: string[] = []
        for (const { name, args, type, description, deprecationReason } of Object.values(fields)) {
            const extraComment = bareIsScalar(type)
                ? ` * @type ${this.#typename(type)}`
                : ` * @type {${this.#typename(type)}}`
            result.push(
                ...this.#comment(description, deprecationReason, undefined, [extraComment]),
                ...this.#selectField(context, name, args, type)
            )
        }
        return result
    }

    #selectField(
        context: GraphQLType,
        name: string,
        args: ReadonlyArray<GraphQLArgument>,
        type: GraphQLType
    ): string[] {
        const contextName = this.#selectName(context)
        const result: string[] = []

        this.#import(RuntimeLib, "ExtendSelected", true)
        if (args.length > 0) {
            this.#import(RuntimeLib, "Arguments", true)
            this.#import(RuntimeLib, "ToVars", true)
            const [argumentType, _] = this.#argumentsType(contextName, args)
            const VP = `[...P, ${JSON.stringify(name)}]`

            if (bareIsScalar(type)) {
                const R = `ExtendSelected<R, [${JSON.stringify(name)}]>`
                const V = `V & ToVars<${argumentType}, ${VP}, A>`
                const returnType = this.#omit(this.#selectType(contextName, R, V, "P"), name)
                result.push(`${name}<A extends Arguments<${argumentType}>>(args: A): ${returnType}`)
            } else {
                const R = `ExtendSelected<R, [Record<${JSON.stringify(name)}, SR>]>`
                const V = `V & SV & ToVars<${argumentType}, ${VP}, A>`
                const returnType = this.#omit(this.#selectType(contextName, R, V, "P"), name)
                const subs = this.#subSelectType(this.#selectName(type), `["__typename"]`, "{}", `[...P, "${name}"]`)
                const subf = `(select: ${subs}) => Selection<ST, SR, SV>`
                result.push(
                    `${name}<A extends Arguments<${argumentType}>, ST, SR extends SelectionDef, SV extends Vars>(args: A, select: ${subf}): ${returnType}`
                )
            }
        } else {
            if (bareIsScalar(type)) {
                const R = `ExtendSelected<R, [${JSON.stringify(name)}]>`
                const V = `V`
                const returnType = this.#omit(this.#selectType(contextName, R, V, "P"), name)
                result.push(`${name}: ${returnType}`)
            } else {
                const R = `ExtendSelected<R, [Record<${JSON.stringify(name)}, SR>]>`
                const V = `V & SV`
                const returnType = this.#omit(this.#selectType(contextName, R, V, "P"), name)
                const subs = this.#subSelectType(this.#selectName(type), `["__typename"]`, "{}", `[...P, "${name}"]`)
                const subf = `(select: ${subs}) => Selection<ST, SR, SV>`
                result.push(`${name}<ST, SR extends SelectionDef, SV extends Vars>(select: ${subf}): ${returnType}`)
            }
        }
        return result
    }

    #onFns(type: GraphQLType): string[] {
        // this.#import(RuntimeLib, "OnFnResult", true)
        const selfT = this.#selectType(this.#selectName(type), "[...R, ...SR]", "V & SV", "P")
        const onSelf = `$on<SR extends SelectionDef, SV extends Vars>(fragment: Selection<${this.#bareTypename(type)}, SR, SV>): ${selfT}`
        const result: string[] = [onSelf]

        // TODO: maybe once upon a time
        // const otherSelfT = this.#selectType(this.#selectName(type), "R | SR", "V & SV", "P")
        // const fragmentTypes: string[] = []

        // if (isUnionType(type)) {
        //     for (const entry of this.#expandTypes(type)) {
        //         const entryAny = this.#selectType(this.#selectName(entry), "any", "any", "any")
        //         result.push(`$on<SR, SV extends Vars>(fragment: ${entryAny}): ${otherSelfT}`)
        //         fragmentTypes.push(entryAny)
        //     }
        // } else if (isInterfaceType(type)) {
        //     for (const entry of this.#expandTypes(type)) {
        //         const entryAny = this.#selectType(this.#selectName(entry), "any", "any", "any")
        //         result.push(`$on<SR, SV extends Vars>(fragment: ${entryAny}): ${otherSelfT}`)
        //         fragmentTypes.push(entryAny)
        //     }
        // }

        // if (fragmentTypes.length > 0) {
        //     result.push(`$on<SR, SV extends Vars>(fragments: ${fragmentTypes.join(" | ")}): ${selfT} | ${otherSelfT}`)
        // }

        return result
    }

    #__typenames(type: GraphQLType): string[] {
        return this.#expandTypes(type).map(v => this.#bareTypename(v))
    }

    #expandTypes(type: GraphQLType): GraphQLType[] {
        if (isUnionType(type)) {
            return Array.from(type.getTypes())
        } else if (isInterfaceType(type)) {
            const result: GraphQLType[] = []
            const impls = this.schema.getImplementations(type)
            for (const t of impls.interfaces) {
                result.push(...this.#expandTypes(t))
            }
            for (const t of impls.objects) {
                result.push(...this.#expandTypes(t))
            }
            return result
        } else if (isListType(type)) {
            return this.#expandTypes(type.ofType)
        } else if (isNonNullType(type)) {
            return this.#expandTypes(type.ofType)
        } else {
            return [type]
        }
    }

    #selectType(name: string, R: string, V: string, P: string): string {
        return `${name}<${R}, ${V}, ${P}>`
    }

    #selectR(type: GraphQLType): string {
        const bare = this.#bareType(type)
        if (isUnionType(bare)) {
            return "[]"
        } else if (isInterfaceType(bare)) {
            return "[]"
        } else {
            return `["__typename"]`
        }
    }

    #subSelectType(name: string, R: string, V: string, P: string): string {
        return this.#selectType(name, R, V, P)
    }

    #argumentsType(prefix: string, args: ReadonlyArray<GraphQLArgument>): [string, string] {
        const argName = `${prefix}Args`
        let argInfoName: string

        const result: string[] = [`export type ${argName} = {`]
        const info: Record<string, string> = {}

        for (const { name, type, description, deprecationReason, defaultValue } of args) {
            result.push(
                ...this.#comment(description, deprecationReason, defaultValue).map(v => `${this.#indent}${v}`),
                `${this.#indent}${name}: ${this.#typename(type)}`
            )
            info[name] = type.toString()
        }

        result.push("}")

        const infoKey = Object.entries(info)
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(v => v.join(":"))
            .join(",")
        if (!(infoKey in this.#argumentInfosName)) {
            argInfoName = `__ArgumentInfo${Object.keys(this.#argumentInfosName).length}`
            this.#argumentInfosName[infoKey] = argInfoName
            this.#argumentInfos.push(`const ${argInfoName} = ${JSON.stringify(info)}`)
        } else {
            argInfoName = this.#argumentInfosName[infoKey]
        }

        this.#argumentTypes[argName] = result.join("\n")
        return [argName, argInfoName] as const
    }

    #omit(t: string, field: string): string {
        return `Omit<${t}, keyof R | "${field}">`
        // return `Omit<${t}, keyof R | "${field}" | "$build" | "$gql">`
    }

    // Array<Alma>
    // Array<Alma> | null
    // Array<Alma | null> | null
    #resultType(type: GraphQLType, name: string, nullable: boolean = true): string {
        if (isListType(type)) {
            return `Array<${this.#resultType(type.ofType, name, true)}>${nullable ? " | null" : ""}`
        } else if (isNonNullType(type)) {
            return this.#resultType(type.ofType, name, false)
        } else if (nullable) {
            return `${name} | null`
        } else {
            return name
        }
    }

    #comment(
        text?: string | null,
        deprecationReason?: string | null,
        defaultValue?: unknown,
        extra?: string[]
    ): string[] {
        const result: string[] = []

        result.push(`/**`)
        if (text != null) {
            result.push(...text.split(/\r?\n/g).map(line => ` * ${line.trim()}`))
        }
        if (defaultValue != null) {
            result.push(` * @default ${JSON.stringify(defaultValue)}`)
        }
        if (deprecationReason != null) {
            result.push(` * @deprecated ${deprecationReason}`)
        }
        if (extra != null) {
            result.push(...extra)
        }
        result.push(" */")

        return result.length === 2 ? [] : result
    }

    #import(_from: string, what: string, isType: boolean) {
        if (!(_from in this.#imports)) {
            this.#imports[_from] = {}
        }

        this.#imports[_from][what] = isType
    }
}

function bareIsScalar(type: GraphQLType) {
    if (isListType(type)) {
        return bareIsScalar(type.ofType)
    } else if (isNonNullType(type)) {
        return bareIsScalar(type.ofType)
    }
    return isScalarType(type)
}
