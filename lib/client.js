window.__ModuleLoader__.load({
	id: "@dsh-external/dsh-parallel-pool",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var react = require("react");

		const NS = "dsh-parallel-pool";
		const MIN_CONCURRENCY = 1;
		const MAX_CONCURRENCY = 16;
		const inject = ["slots", "settingsScope"];

		/** dsh-parallel-pool 设置卡片：编辑默认并发数。 */
		function ParallelPoolCard(props) {
			const { scope, onSave, onReset } = props;
			const snapshot = react.useSyncExternalStore(
				(callback) => scope.subscribe(callback),
				() => scope.getSnapshot()
			);
			const [draft, setDraft] = react.useState("");

			react.useEffect(() => {
				const value = snapshot && snapshot.value ? snapshot.value.maxConcurrency : undefined;
				setDraft(value !== undefined ? String(value) : "");
			}, [snapshot]);

			if (!snapshot || snapshot.status !== "ready") return null;

			const writable = snapshot.writable === true;
			const overridden = Boolean(snapshot.user && snapshot.user.maxConcurrency !== undefined);
			const numeric = /^\d+$/.test(draft);
			const num = Number(draft);
			const invalid = !numeric || !Number.isInteger(num) || num < MIN_CONCURRENCY || num > MAX_CONCURRENCY;

			return react.createElement(
				"li",
				{ style: { listStyle: "none", border: "1px solid #d0d7de", borderRadius: 8, padding: 12, marginBottom: 8 } },
				react.createElement("div", { style: { fontWeight: 600 } }, "dsh-parallel-pool"),
				react.createElement("div", { style: { color: "#57606a", marginBottom: 8 } }, "默认并发数（maxConcurrency）"),
				react.createElement("label", { htmlFor: "dsh-parallel-pool-max-concurrency" }, "maxConcurrency"),
				react.createElement("input", {
					id: "dsh-parallel-pool-max-concurrency",
					type: "number",
					min: MIN_CONCURRENCY,
					max: MAX_CONCURRENCY,
					step: 1,
					value: draft,
					disabled: !writable,
					onChange: (event) => setDraft(event.target.value),
					style: { marginLeft: 8, width: 80 }
				}),
				overridden
					? react.createElement("button", {
						type: "button",
						onClick: onReset,
						disabled: !writable,
						style: { marginLeft: 8 }
					}, "reset")
					: null,
				react.createElement("button", {
					type: "button",
					onClick: () => onSave(num),
					disabled: invalid || !writable,
					style: { marginLeft: 8 }
				}, "save"),
				invalid
					? react.createElement("span", { style: { color: "#cf222e", marginLeft: 8 } }, "1-16 integer")
					: null
			);
		}

		function apply(ctx) {
			const scope = ctx.settingsScope.bind({ namespace: NS });
			ctx.effect(() => ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
				name: "settings.plugin.item",
				key: NS,
				order: 0,
				inject: () => ({
					scope,
					onSave: (value) => scope.set("maxConcurrency", value),
					onReset: () => scope.unset("maxConcurrency")
				})
			}, ParallelPoolCard)), "dsh-parallel-pool: settings card");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
