/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 4 -*-
 * vim: set ts=8 sts=4 et sw=4 tw=99:
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef jit_AsmJSModule_h
#define jit_AsmJSModule_h

#ifdef JS_ION

#include "jsscript.h"

#include "gc/Marking.h"
#include "jit/AsmJS.h"
#include "jit/IonMacroAssembler.h"
#if defined(JS_ION_PERF)
# include "jit/PerfSpewer.h"
#endif
#include "jit/RegisterSets.h"

namespace js {

// These EcmaScript-defined coercions form the basis of the asm.js type system.
enum AsmJSCoercion
{
    AsmJS_ToInt32,
    AsmJS_ToNumber
};

// The asm.js spec recognizes this set of builtin Math functions.
enum AsmJSMathBuiltin
{
    AsmJSMathBuiltin_sin, AsmJSMathBuiltin_cos, AsmJSMathBuiltin_tan,
    AsmJSMathBuiltin_asin, AsmJSMathBuiltin_acos, AsmJSMathBuiltin_atan,
    AsmJSMathBuiltin_ceil, AsmJSMathBuiltin_floor, AsmJSMathBuiltin_exp,
    AsmJSMathBuiltin_log, AsmJSMathBuiltin_pow, AsmJSMathBuiltin_sqrt,
    AsmJSMathBuiltin_abs, AsmJSMathBuiltin_atan2, AsmJSMathBuiltin_imul
};

// An asm.js module represents the collection of functions nested inside a
// single outer "use asm" function. For example, this asm.js module:
//   function() { "use asm"; function f() {} function g() {} return f }
// contains the functions 'f' and 'g'.
//
// An asm.js module contains both the jit-code produced by compiling all the
// functions in the module as well all the data required to perform the
// link-time validation step in the asm.js spec.
//
// NB: this means that AsmJSModule must be GC-safe.
class AsmJSModule
{
  public:
    class Global
    {
      public:
        enum Which { Variable, FFI, ArrayView, MathBuiltin, Constant };
        enum VarInitKind { InitConstant, InitImport };

      private:
        Which which_;
        union {
            struct {
                uint32_t index_;
                VarInitKind initKind_;
                union {
                    Value constant_; // will only contain int32/double
                    AsmJSCoercion coercion_;
                } init;
            } var;
            uint32_t ffiIndex_;
            ArrayBufferView::ViewType viewType_;
            AsmJSMathBuiltin mathBuiltin_;
            double constantValue_;
        } u;
        PropertyName *name_;

        friend class AsmJSModule;
        Global(Which which, PropertyName *name)
          : which_(which), name_(name)
        {
            JS_ASSERT_IF(name_, name_->isTenured());
        }

        void trace(JSTracer *trc) {
            if (name_)
                MarkStringUnbarriered(trc, &name_, "asm.js global name");
            JS_ASSERT_IF(which_ == Variable && u.var.initKind_ == InitConstant,
                         !u.var.init.constant_.isMarkable());
        }

      public:
        Which which() const {
            return which_;
        }
        uint32_t varIndex() const {
            JS_ASSERT(which_ == Variable);
            return u.var.index_;
        }
        VarInitKind varInitKind() const {
            JS_ASSERT(which_ == Variable);
            return u.var.initKind_;
        }
        const Value &varInitConstant() const {
            JS_ASSERT(which_ == Variable);
            JS_ASSERT(u.var.initKind_ == InitConstant);
            return u.var.init.constant_;
        }
        AsmJSCoercion varImportCoercion() const {
            JS_ASSERT(which_ == Variable);
            JS_ASSERT(u.var.initKind_ == InitImport);
            return u.var.init.coercion_;
        }
        PropertyName *varImportField() const {
            JS_ASSERT(which_ == Variable);
            JS_ASSERT(u.var.initKind_ == InitImport);
            return name_;
        }
        PropertyName *ffiField() const {
            JS_ASSERT(which_ == FFI);
            return name_;
        }
        uint32_t ffiIndex() const {
            JS_ASSERT(which_ == FFI);
            return u.ffiIndex_;
        }
        PropertyName *viewName() const {
            JS_ASSERT(which_ == ArrayView);
            return name_;
        }
        ArrayBufferView::ViewType viewType() const {
            JS_ASSERT(which_ == ArrayView);
            return u.viewType_;
        }
        PropertyName *mathName() const {
            JS_ASSERT(which_ == MathBuiltin);
            return name_;
        }
        AsmJSMathBuiltin mathBuiltin() const {
            JS_ASSERT(which_ == MathBuiltin);
            return u.mathBuiltin_;
        }
        PropertyName *constantName() const {
            JS_ASSERT(which_ == Constant);
            return name_;
        }
        double constantValue() const {
            JS_ASSERT(which_ == Constant);
            return u.constantValue_;
        }
    };

    class Exit
    {
        unsigned ffiIndex_;
        unsigned globalDataOffset_;

        union {
            unsigned codeOffset_;
            uint8_t *code_;
        } interp;

        union {
            unsigned codeOffset_;
            uint8_t *code_;
        } ion;

      public:
        Exit(unsigned ffiIndex, unsigned globalDataOffset)
          : ffiIndex_(ffiIndex), globalDataOffset_(globalDataOffset)
        {
          interp.codeOffset_ = 0;
          ion.codeOffset_ = 0;
        }
        unsigned ffiIndex() const {
            return ffiIndex_;
        }
        unsigned globalDataOffset() const {
            return globalDataOffset_;
        }
        void initInterpOffset(unsigned off) {
            JS_ASSERT(!interp.codeOffset_);
            interp.codeOffset_ = off;
        }
        void initIonOffset(unsigned off) {
            JS_ASSERT(!ion.codeOffset_);
            ion.codeOffset_ = off;
        }
        void patch(uint8_t *baseAddress) {
            interp.code_ = baseAddress + interp.codeOffset_;
            ion.code_ = baseAddress + ion.codeOffset_;
        }
        uint8_t *interpCode() const {
            return interp.code_;
        }
        uint8_t *ionCode() const {
            return ion.code_;
        }
    };
#ifdef JS_CPU_ARM
    typedef int32_t (*CodePtr)(uint64_t *args, uint8_t *global);
#else
    typedef int32_t (*CodePtr)(uint64_t *args);
#endif

    typedef Vector<AsmJSCoercion, 0, SystemAllocPolicy> ArgCoercionVector;

    enum ReturnType { Return_Int32, Return_Double, Return_Void };

    class ExportedFunction
    {
        PropertyName *name_;
        PropertyName *maybeFieldName_;
        ArgCoercionVector argCoercions_;
        ReturnType returnType_;
        bool hasCodePtr_;
        union {
            unsigned codeOffset_;
            CodePtr code_;
        } u;

        friend class AsmJSModule;

        ExportedFunction(PropertyName *name,
                         PropertyName *maybeFieldName,
                         mozilla::MoveRef<ArgCoercionVector> argCoercions,
                         ReturnType returnType)
          : name_(name),
            maybeFieldName_(maybeFieldName),
            argCoercions_(argCoercions),
            returnType_(returnType),
            hasCodePtr_(false)
        {
            u.codeOffset_ = 0;
            JS_ASSERT_IF(maybeFieldName_, name_->isTenured());
        }

        void trace(JSTracer *trc) {
            MarkStringUnbarriered(trc, &name_, "asm.js export name");
            if (maybeFieldName_)
                MarkStringUnbarriered(trc, &maybeFieldName_, "asm.js export field");
        }

      public:
        ExportedFunction(mozilla::MoveRef<ExportedFunction> rhs)
          : name_(rhs->name_),
            maybeFieldName_(rhs->maybeFieldName_),
            argCoercions_(mozilla::Move(rhs->argCoercions_)),
            returnType_(rhs->returnType_),
            hasCodePtr_(rhs->hasCodePtr_),
            u(rhs->u)
        {}

        void initCodeOffset(unsigned off) {
            JS_ASSERT(!hasCodePtr_);
            JS_ASSERT(!u.codeOffset_);
            u.codeOffset_ = off;
        }
        void patch(uint8_t *baseAddress) {
            JS_ASSERT(!hasCodePtr_);
            JS_ASSERT(u.codeOffset_);
            hasCodePtr_ = true;
            u.code_ = JS_DATA_TO_FUNC_PTR(CodePtr, baseAddress + u.codeOffset_);
        }

        PropertyName *name() const {
            return name_;
        }
        PropertyName *maybeFieldName() const {
            return maybeFieldName_;
        }
        unsigned numArgs() const {
            return argCoercions_.length();
        }
        AsmJSCoercion argCoercion(unsigned i) const {
            return argCoercions_[i];
        }
        ReturnType returnType() const {
            return returnType_;
        }
        CodePtr code() const {
            JS_ASSERT(hasCodePtr_);
            return u.code_;
        }
    };

#if defined(MOZ_VTUNE) or defined(JS_ION_PERF)
    // Function information to add to the VTune JIT profiler following linking.
    struct ProfiledFunction
    {
        JSAtom *name;
        unsigned startCodeOffset;
        unsigned endCodeOffset;
        unsigned lineno;
        unsigned columnIndex;

        ProfiledFunction(JSAtom *name, unsigned start, unsigned end,
                         unsigned line = 0U, unsigned column = 0U)
          : name(name),
            startCodeOffset(start),
            endCodeOffset(end),
            lineno(line),
            columnIndex(column)
        {
            JS_ASSERT(name->isTenured());
        }

        void trace(JSTracer *trc) {
            MarkStringUnbarriered(trc, &name, "asm.js profiled function name");
        }
    };
#endif

#if defined(JS_ION_PERF)
    struct ProfiledBlocksFunction : public ProfiledFunction
    {
        jit::PerfSpewer::BasicBlocksVector blocks;

        ProfiledBlocksFunction(JSAtom *name, unsigned start, unsigned end, jit::PerfSpewer::BasicBlocksVector &blocksVector)
          : ProfiledFunction(name, start, end), blocks(mozilla::Move(blocksVector))
        { }

        ProfiledBlocksFunction(const ProfiledBlocksFunction &copy)
          : ProfiledFunction(copy.name, copy.startCodeOffset, copy.endCodeOffset), blocks(mozilla::Move(copy.blocks))
        { }
    };
#endif

  private:
    typedef Vector<ExportedFunction, 0, SystemAllocPolicy> ExportedFunctionVector;
    typedef Vector<Global, 0, SystemAllocPolicy> GlobalVector;
    typedef Vector<Exit, 0, SystemAllocPolicy> ExitVector;
    typedef Vector<jit::AsmJSHeapAccess, 0, SystemAllocPolicy> HeapAccessVector;
    typedef Vector<jit::IonScriptCounts *, 0, SystemAllocPolicy> FunctionCountsVector;
#if defined(MOZ_VTUNE) or defined(JS_ION_PERF)
    typedef Vector<ProfiledFunction, 0, SystemAllocPolicy> ProfiledFunctionVector;
#endif

    GlobalVector                          globals_;
    ExitVector                            exits_;
    ExportedFunctionVector                exports_;
    HeapAccessVector                      heapAccesses_;
#if defined(MOZ_VTUNE)
    ProfiledFunctionVector                profiledFunctions_;
#endif
#if defined(JS_ION_PERF)
    ProfiledFunctionVector                perfProfiledFunctions_;
    Vector<ProfiledBlocksFunction, 0, SystemAllocPolicy> perfProfiledBlocksFunctions_;
#endif

    uint32_t                              numGlobalVars_;
    uint32_t                              numFFIs_;
    size_t                                funcPtrTableAndExitBytes_;
    bool                                  hasArrayView_;

    uint8_t *                             code_;
    uint8_t *                             operationCallbackExit_;
    size_t                                functionBytes_;
    size_t                                codeBytes_;
    size_t                                totalBytes_;

    bool                                  linked_;
    HeapPtr<ArrayBufferObject>            maybeHeap_;

    HeapPtrPropertyName                   globalArgumentName_;
    HeapPtrPropertyName                   importArgumentName_;
    HeapPtrPropertyName                   bufferArgumentName_;

    AsmJSModuleSourceDesc                 sourceDesc_;
    FunctionCountsVector                  functionCounts_;

  public:
    explicit AsmJSModule()
      : numGlobalVars_(0),
        numFFIs_(0),
        funcPtrTableAndExitBytes_(0),
        hasArrayView_(false),
        code_(NULL),
        operationCallbackExit_(NULL),
        functionBytes_(0),
        codeBytes_(0),
        totalBytes_(0),
        linked_(false),
        maybeHeap_(),
        sourceDesc_()
    {}

    ~AsmJSModule();

    void trace(JSTracer *trc) {
        for (unsigned i = 0; i < globals_.length(); i++)
            globals_[i].trace(trc);
        for (unsigned i = 0; i < exports_.length(); i++)
            exports_[i].trace(trc);
        for (unsigned i = 0; i < exits_.length(); i++) {
            if (exitIndexToGlobalDatum(i).fun)
                MarkObject(trc, &exitIndexToGlobalDatum(i).fun, "asm.js imported function");
        }
#if defined(MOZ_VTUNE)
        for (unsigned i = 0; i < profiledFunctions_.length(); i++)
            profiledFunctions_[i].trace(trc);
#endif
#if defined(JS_ION_PERF)
        for (unsigned i = 0; i < perfProfiledFunctions_.length(); i++)
            perfProfiledFunctions_[i].trace(trc);
        for (unsigned i = 0; i < perfProfiledBlocksFunctions_.length(); i++)
            perfProfiledBlocksFunctions_[i].trace(trc);
#endif
        if (maybeHeap_)
            MarkObject(trc, &maybeHeap_, "asm.js heap");

        if (globalArgumentName_)
            MarkString(trc, &globalArgumentName_, "asm.js global argument name");
        if (importArgumentName_)
            MarkString(trc, &importArgumentName_, "asm.js import argument name");
        if (bufferArgumentName_)
            MarkString(trc, &bufferArgumentName_, "asm.js buffer argument name");
    }

    bool addGlobalVarInitConstant(const Value &v, uint32_t *globalIndex) {
        JS_ASSERT(!v.isMarkable());
        JS_ASSERT(funcPtrTableAndExitBytes_ == 0);
        if (numGlobalVars_ == UINT32_MAX)
            return false;
        Global g(Global::Variable, NULL);
        g.u.var.initKind_ = Global::InitConstant;
        g.u.var.init.constant_ = v;
        g.u.var.index_ = *globalIndex = numGlobalVars_++;
        return globals_.append(g);
    }
    bool addGlobalVarImport(PropertyName *name, AsmJSCoercion coercion, uint32_t *globalIndex) {
        JS_ASSERT(funcPtrTableAndExitBytes_ == 0);
        Global g(Global::Variable, name);
        g.u.var.initKind_ = Global::InitImport;
        g.u.var.init.coercion_ = coercion;
        g.u.var.index_ = *globalIndex = numGlobalVars_++;
        return globals_.append(g);
    }
    bool addFFI(PropertyName *field, uint32_t *ffiIndex) {
        if (numFFIs_ == UINT32_MAX)
            return false;
        Global g(Global::FFI, field);
        g.u.ffiIndex_ = *ffiIndex = numFFIs_++;
        return globals_.append(g);
    }
    bool addArrayView(ArrayBufferView::ViewType vt, PropertyName *field) {
        hasArrayView_ = true;
        Global g(Global::ArrayView, field);
        g.u.viewType_ = vt;
        return globals_.append(g);
    }
    bool addMathBuiltin(AsmJSMathBuiltin mathBuiltin, PropertyName *field) {
        Global g(Global::MathBuiltin, field);
        g.u.mathBuiltin_ = mathBuiltin;
        return globals_.append(g);
    }
    bool addGlobalConstant(double value, PropertyName *name) {
        Global g(Global::Constant, name);
        g.u.constantValue_ = value;
        return globals_.append(g);
    }
    bool addFuncPtrTable(unsigned numElems, uint32_t *globalDataOffset) {
        JS_ASSERT(IsPowerOfTwo(numElems));
        if (SIZE_MAX - funcPtrTableAndExitBytes_ < numElems * sizeof(void*))
            return false;
        *globalDataOffset = globalDataBytes();
        funcPtrTableAndExitBytes_ += numElems * sizeof(void*);
        return true;
    }
    bool addExit(unsigned ffiIndex, unsigned *exitIndex) {
        if (SIZE_MAX - funcPtrTableAndExitBytes_ < sizeof(ExitDatum))
            return false;
        uint32_t globalDataOffset = globalDataBytes();
        JS_STATIC_ASSERT(sizeof(ExitDatum) % sizeof(void*) == 0);
        funcPtrTableAndExitBytes_ += sizeof(ExitDatum);
        *exitIndex = unsigned(exits_.length());
        return exits_.append(Exit(ffiIndex, globalDataOffset));
    }
    bool addFunctionCounts(jit::IonScriptCounts *counts) {
        return functionCounts_.append(counts);
    }

    bool addExportedFunction(PropertyName *name, PropertyName *maybeFieldName,
                             mozilla::MoveRef<ArgCoercionVector> argCoercions,
                             ReturnType returnType)
    {
        ExportedFunction func(name, maybeFieldName, argCoercions, returnType);
        return exports_.append(mozilla::Move(func));
    }
    unsigned numExportedFunctions() const {
        return exports_.length();
    }
    const ExportedFunction &exportedFunction(unsigned i) const {
        return exports_[i];
    }
    ExportedFunction &exportedFunction(unsigned i) {
        return exports_[i];
    }
#ifdef MOZ_VTUNE
    bool trackProfiledFunction(JSAtom *name, unsigned startCodeOffset, unsigned endCodeOffset) {
        ProfiledFunction func(name, startCodeOffset, endCodeOffset);
        return profiledFunctions_.append(func);
    }
    unsigned numProfiledFunctions() const {
        return profiledFunctions_.length();
    }
    const ProfiledFunction &profiledFunction(unsigned i) const {
        return profiledFunctions_[i];
    }
#endif
#ifdef JS_ION_PERF
    bool trackPerfProfiledFunction(JSAtom *name, unsigned startCodeOffset, unsigned endCodeOffset,
                                   unsigned line, unsigned column)
    {
        ProfiledFunction func(name, startCodeOffset, endCodeOffset, line, column);
        return perfProfiledFunctions_.append(func);
    }
    unsigned numPerfFunctions() const {
        return perfProfiledFunctions_.length();
    }
    const ProfiledFunction &perfProfiledFunction(unsigned i) const {
        return perfProfiledFunctions_[i];
    }

    bool trackPerfProfiledBlocks(JSAtom *name, unsigned startCodeOffset, unsigned endCodeOffset, jit::PerfSpewer::BasicBlocksVector &basicBlocks) {
        ProfiledBlocksFunction func(name, startCodeOffset, endCodeOffset, basicBlocks);
        return perfProfiledBlocksFunctions_.append(func);
    }
    unsigned numPerfBlocksFunctions() const {
        return perfProfiledBlocksFunctions_.length();
    }
    const ProfiledBlocksFunction perfProfiledBlocksFunction(unsigned i) const {
        return perfProfiledBlocksFunctions_[i];
    }
#endif
    bool hasArrayView() const {
        return hasArrayView_;
    }
    unsigned numFFIs() const {
        return numFFIs_;
    }
    unsigned numGlobalVars() const {
        return numGlobalVars_;
    }
    unsigned numGlobals() const {
        return globals_.length();
    }
    Global &global(unsigned i) {
        return globals_[i];
    }
    unsigned numExits() const {
        return exits_.length();
    }
    Exit &exit(unsigned i) {
        return exits_[i];
    }
    const Exit &exit(unsigned i) const {
        return exits_[i];
    }
    unsigned numFunctionCounts() const {
        return functionCounts_.length();
    }
    jit::IonScriptCounts *functionCounts(unsigned i) {
        return functionCounts_[i];
    }

    // An Exit holds bookkeeping information about an exit; the ExitDatum
    // struct overlays the actual runtime data stored in the global data
    // section.
    struct ExitDatum
    {
        uint8_t *exit;
        HeapPtrFunction fun;
    };

    // Global data section
    //
    // The global data section is placed after the executable code (i.e., at
    // offset codeBytes_) in the module's linear allocation. The global data
    // are laid out in this order:
    //   0. a pointer/descriptor for the heap that was linked to the module
    //   1. global variable state (elements are sizeof(uint64_t))
    //   2. interleaved function-pointer tables and exits. These are allocated
    //      while type checking function bodies (as exits and uses of
    //      function-pointer tables are encountered).
    uint8_t *globalData() const {
        JS_ASSERT(code_);
        return code_ + codeBytes_;
    }

    size_t globalDataBytes() const {
        return sizeof(void*) +
               numGlobalVars_ * sizeof(uint64_t) +
               funcPtrTableAndExitBytes_;
    }
    unsigned heapOffset() const {
        return 0;
    }
    uint8_t *&heapDatum() const {
        return *(uint8_t**)(globalData() + heapOffset());
    }
    unsigned globalVarIndexToGlobalDataOffset(unsigned i) const {
        JS_ASSERT(i < numGlobalVars_);
        return sizeof(void*) +
               i * sizeof(uint64_t);
    }
    void *globalVarIndexToGlobalDatum(unsigned i) const {
        return (void *)(globalData() + globalVarIndexToGlobalDataOffset(i));
    }
    uint8_t **globalDataOffsetToFuncPtrTable(unsigned globalDataOffset) const {
        JS_ASSERT(globalDataOffset < globalDataBytes());
        return (uint8_t **)(globalData() + globalDataOffset);
    }
    unsigned exitIndexToGlobalDataOffset(unsigned exitIndex) const {
        return exits_[exitIndex].globalDataOffset();
    }
    ExitDatum &exitIndexToGlobalDatum(unsigned exitIndex) const {
        return *(ExitDatum *)(globalData() + exitIndexToGlobalDataOffset(exitIndex));
    }

    void initFunctionBytes(size_t functionBytes) {
        JS_ASSERT(functionBytes_ == 0);
        JS_ASSERT(functionBytes % AsmJSPageSize == 0);
        functionBytes_ = functionBytes;
    }
    size_t functionBytes() const {
        JS_ASSERT(functionBytes_);
        JS_ASSERT(functionBytes_ % AsmJSPageSize == 0);
        return functionBytes_;
    }
    bool containsPC(void *pc) const {
        uint8_t *code = functionCode();
        return pc >= code && pc < (code + functionBytes());
    }

    bool addHeapAccesses(const jit::AsmJSHeapAccessVector &accesses) {
        return heapAccesses_.appendAll(accesses);
    }
    unsigned numHeapAccesses() const {
        return heapAccesses_.length();
    }
    jit::AsmJSHeapAccess &heapAccess(unsigned i) {
        return heapAccesses_[i];
    }
    const jit::AsmJSHeapAccess &heapAccess(unsigned i) const {
        return heapAccesses_[i];
    }
    void patchHeapAccesses(ArrayBufferObject *heap, JSContext *cx);

    uint8_t *allocateCodeAndGlobalSegment(ExclusiveContext *cx, size_t bytesNeeded);

    uint8_t *functionCode() const {
        JS_ASSERT(code_);
        JS_ASSERT(uintptr_t(code_) % AsmJSPageSize == 0);
        return code_;
    }

    void setOperationCallbackExit(uint8_t *ptr) {
        operationCallbackExit_ = ptr;
    }
    uint8_t *operationCallbackExit() const {
        return operationCallbackExit_;
    }

    void setIsLinked(Handle<ArrayBufferObject*> maybeHeap) {
        JS_ASSERT(!linked_);
        linked_ = true;
        maybeHeap_ = maybeHeap;
        heapDatum() = maybeHeap_ ? maybeHeap_->dataPointer() : NULL;
    }
    bool isLinked() const {
        return linked_;
    }
    uint8_t *maybeHeap() const {
        JS_ASSERT(linked_);
        return heapDatum();
    }
    size_t heapLength() const {
        JS_ASSERT(linked_);
        return maybeHeap_ ? maybeHeap_->byteLength() : 0;
    }

    void initGlobalArgumentName(PropertyName *n) { globalArgumentName_ = n; }
    void initImportArgumentName(PropertyName *n) { importArgumentName_ = n; }
    void initBufferArgumentName(PropertyName *n) { bufferArgumentName_ = n; }

    PropertyName *globalArgumentName() const { return globalArgumentName_; }
    PropertyName *importArgumentName() const { return importArgumentName_; }
    PropertyName *bufferArgumentName() const { return bufferArgumentName_; }

    void initSourceDesc(ScriptSource *scriptSource, uint32_t bufStart, uint32_t bufEnd) {
        sourceDesc_.init(scriptSource, bufStart, bufEnd);
    }
    const AsmJSModuleSourceDesc &sourceDesc() const {
        return sourceDesc_;
    }

    void detachIonCompilation(size_t exitIndex) const {
        exitIndexToGlobalDatum(exitIndex).exit = exit(exitIndex).interpCode();
    }

    // Part of about:memory reporting:
    void sizeOfMisc(mozilla::MallocSizeOf mallocSizeOf, size_t *asmJSModuleCode,
                    size_t *asmJSModuleData);
};

// An AsmJSModuleObject is an internal implementation object (i.e., not exposed
// directly to user script) which manages the lifetime of an AsmJSModule. A
// JSObject is necessary since we want LinkAsmJS/CallAsmJS JSFunctions to be
// able to point to their module via their extended slots.
class AsmJSModuleObject : public JSObject
{
    static const unsigned MODULE_SLOT = 0;

  public:
    static const unsigned RESERVED_SLOTS = 1;

    // On success, return an AsmJSModuleClass JSObject that has taken ownership
    // (and release()ed) the given module.
    static AsmJSModuleObject *create(ExclusiveContext *cx, ScopedJSDeletePtr<AsmJSModule> *module);

    AsmJSModule &module() const;

    void sizeOfMisc(mozilla::MallocSizeOf mallocSizeOf, size_t *asmJSModuleCode,
                    size_t *asmJSModuleData) {
        module().sizeOfMisc(mallocSizeOf, asmJSModuleCode, asmJSModuleData);
    }

    static Class class_;
};

}  // namespace js

#endif  // JS_ION

#endif /* jit_AsmJSModule_h */
