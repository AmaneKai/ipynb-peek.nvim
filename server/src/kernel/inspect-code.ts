/**
 * Python run (quietly) in the user's kernel to list its variables. Prints one
 * marker-delimited JSON line, so whatever else is on stdout can't corrupt it.
 *
 * Skips what IPython's own `%whos` hides: underscore names, the namespace's
 * initial entries, and modules/functions/classes. Every probe is guarded -
 * inspecting a user object must never be able to fail the whole listing.
 */
export const INSPECT_START = "\u001eIPK_VARS"
export const INSPECT_END = "\u001e"

export const INSPECT_CODE = `
def __ipk_vars():
    import json, sys, types, reprlib
    ip = get_ipython()
    ns, hidden = ip.user_ns, getattr(ip, "user_ns_hidden", {})
    skip = (types.ModuleType, types.FunctionType, types.BuiltinFunctionType, type)
    short = reprlib.Repr()
    short.maxstring = short.maxother = 60
    short.maxlist = short.maxtuple = short.maxdict = short.maxset = 6
    rows = []
    for name, val in list(ns.items()):
        if name.startswith("_") or name in hidden or isinstance(val, skip):
            continue
        row = {"name": name, "type": type(val).__name__, "shape": "", "size_bytes": None, "preview": ""}
        try:
            if isinstance(val, (str, bytes)):
                pass
            elif hasattr(val, "shape"):
                row["shape"] = str(tuple(val.shape))
            elif hasattr(val, "__len__"):
                n = len(val)
                row["shape"] = "%d %s" % (n, "keys" if isinstance(val, dict) else "items")
        except Exception:
            pass
        try:
            if hasattr(val, "memory_usage") and hasattr(val, "columns"):
                row["size_bytes"] = int(val.memory_usage(deep=True).sum())
            elif hasattr(val, "memory_usage"):
                row["size_bytes"] = int(val.memory_usage(deep=True))
            elif hasattr(val, "nbytes"):
                row["size_bytes"] = int(val.nbytes)
            elif hasattr(val, "element_size") and hasattr(val, "nelement"):
                row["size_bytes"] = int(val.element_size() * val.nelement())
            else:
                row["size_bytes"] = int(sys.getsizeof(val))
        except Exception:
            pass
        try:
            if hasattr(val, "columns") and hasattr(val, "shape"):
                row["preview"] = short.repr(list(val.columns))
            elif hasattr(val, "device") and hasattr(val, "dtype"):
                row["preview"] = "%s on %s" % (val.dtype, val.device)
            else:
                row["preview"] = short.repr(val).replace("\\n", " ")[:100]
        except Exception:
            row["preview"] = "<unrepresentable>"
        rows.append(row)
    rows.sort(key=lambda r: -(r["size_bytes"] or 0))
    print("\\x1eIPK_VARS" + json.dumps(rows) + "\\x1e")
__ipk_vars()
del __ipk_vars
`
