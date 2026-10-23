extends SceneTree
# Eyes driver: runs one scene with scripted input, frame by frame, for `eyes run` and `eyes film`.
#
# Started by Eyes as `godot --path <project> --script <this file> --write-movie ... -- --eyes-plan <plan.json>`.
# Godot's movie writer fixes the frame rate and saves every frame; this script counts those frames,
# fires each step's input on its frame, and records checks and shots. Frame N is movie file N:
# inputs fire before the scene processes frame N, and checks read the state that frame N shows.
#
# The plan (written by Eyes):
#   {scene, frames, results, steps: [{n, at, type: press|release|mouse|shot|check, value}]}
# The results (written when Godot quits, however it quits):
#   {frames_run, shots: {name: frame}, checks: [{step, frame, expr, passed, value, error}], problems: [{step, text}],
#    focus_lost: [frame], reapplied: [{frame, input}]}
#
# Input stays held from its `press` step to its `release` step even if the window loses focus: Godot
# releases every pressed key and action then (Input.release_pressed_events), so the driver puts back
# whatever it is still holding before the scene processes the frame, and the results say when it happened.
#
# EYES_TEST_FOCUS_LOSS_AT=<frame> (tests only) simulates the loss at the start of that frame: the held
# input is released behind the driver's back, and the window's focus_exited signal fires.

const OFF_SCREEN := Vector2i(-32000, -32000)
const MAX_VALUE_CHARS := 200
const MOUSE_BUTTONS := {"left": MOUSE_BUTTON_LEFT, "right": MOUSE_BUTTON_RIGHT, "middle": MOUSE_BUTTON_MIDDLE}
const MOUSE_MASKS := {"left": MOUSE_BUTTON_MASK_LEFT, "right": MOUSE_BUTTON_MASK_RIGHT, "middle": MOUSE_BUTTON_MASK_MIDDLE}

var results_path := ""
var frame := -1
var steps_by_frame := {}
var shots := {}
var checks := []
var problems := []
var input_names := PackedStringArray()
var input_values := []
var held := {}
var focus_lost := []
var reapplied := []
var test_focus_loss_at := -1


func _initialize() -> void:
	# A wrapper exe can leave the window on screen; move it away before the first frame is shown.
	DisplayServer.window_set_position(OFF_SCREEN)
	# Every frame is exactly 1/fps: no smoothing of process time against physics ticks.
	Engine.physics_jitter_fix = 0.0

	var plan := _read_plan()
	if plan.is_empty():
		quit(1)
		return
	results_path = str(plan.get("results", ""))
	for step in plan.get("steps", []):
		_check_input_name(step)
		var at := int(step.get("at", 0))
		if not steps_by_frame.has(at):
			steps_by_frame[at] = []
		steps_by_frame[at].append(step)
	if not problems.is_empty():
		quit(1)
		return

	var scene_path := str(plan.get("scene", ""))
	if scene_path == "":
		scene_path = str(ProjectSettings.get_setting("application/run/main_scene", ""))
	if scene_path == "":
		_problem(0, "The project has no main scene (application/run/main_scene); set godot.scene in the scenario")
		quit(1)
		return
	var packed := load(scene_path) as PackedScene
	if packed == null:
		_problem(0, "Could not load the scene %s" % scene_path)
		quit(1)
		return
	# Added now rather than with change_scene_to_file, so frame 0 is already the scene's first frame.
	var scene := packed.instantiate()
	root.add_child(scene)
	current_scene = scene

	# Autoloads by name, so a check can read them like the game does (e.g. "GameState.score > 0").
	for property in ProjectSettings.get_property_list():
		var key := str(property.name)
		if key.begins_with("autoload/"):
			var autoload_name := key.trim_prefix("autoload/")
			var node := root.get_node_or_null(NodePath(autoload_name))
			if node != null:
				input_names.append(autoload_name)
				input_values.append(node)

	RenderingServer.frame_pre_draw.connect(_after_scene_processed)
	root.focus_exited.connect(_on_focus_exited)
	var test_frame := OS.get_environment("EYES_TEST_FOCUS_LOSS_AT")
	if test_frame.is_valid_int():
		test_focus_loss_at = int(test_frame)


func _read_plan() -> Dictionary:
	var args := OS.get_cmdline_user_args()
	var i := args.find("--eyes-plan")
	if i < 0 or i + 1 >= args.size():
		printerr("EYES: the driver needs -- --eyes-plan <plan.json>")
		return {}
	var text := FileAccess.get_file_as_string(args[i + 1])
	var plan = JSON.parse_string(text)
	if typeof(plan) != TYPE_DICTIONARY:
		printerr("EYES: could not read the plan %s" % args[i + 1])
		return {}
	return plan


func _check_input_name(step: Dictionary) -> void:
	var type := str(step.get("type", ""))
	if type != "press" and type != "release":
		return
	var input_name := str(step.get("value", ""))
	if InputMap.has_action(input_name) or OS.find_keycode_from_string(input_name) != KEY_NONE:
		return
	var actions := PackedStringArray()
	for action in InputMap.get_actions():
		if not str(action).begins_with("ui_"):
			actions.append(str(action))
	var listed := ", ".join(actions) if not actions.is_empty() else "none besides the built-in ui_* actions"
	_problem(int(step.get("n", 0)), "\"%s\" is neither an input action in this project nor a key name (like Space, W or Escape). Project actions: %s" % [input_name, listed])


# Between frames: the next frame to be processed is the first one that sees the released input.
func _on_focus_exited() -> void:
	focus_lost.append(frame + 1)


func _process(_delta: float) -> bool:
	if frame + 1 == test_focus_loss_at:
		# What Godot does on a real focus loss (Input.release_pressed_events is not callable from scripts):
		# everything held is released without the driver being told.
		for held_name in held:
			_key(str(held_name), false)
		Input.flush_buffered_events()
		root.focus_exited.emit()
	frame += 1
	# Godot releases everything pressed when the window loses focus. This runs before the scene processes
	# the frame, so a hold lasts exactly from its press step to its release step whatever the OS does.
	Input.flush_buffered_events()
	for held_name in held:
		if not _is_held(str(held_name)):
			_key(str(held_name), true)
			reapplied.append({"frame": frame, "input": str(held_name)})
	for step in steps_by_frame.get(frame, []):
		match str(step.get("type", "")):
			"press":
				held[str(step.value)] = true
				_key(str(step.value), true)
			"release":
				held.erase(str(step.value))
				_key(str(step.value), false)
			"mouse":
				_mouse(step.value)
	# Deliver the events now, so the scene sees them in this frame rather than the next.
	Input.flush_buffered_events()
	return false


# Runs once the scene has processed the frame and before it is drawn: what is checked is what frame N shows.
func _after_scene_processed() -> void:
	if frame < 0:
		return
	for step in steps_by_frame.get(frame, []):
		match str(step.get("type", "")):
			"shot":
				shots[str(step.value)] = frame
			"check":
				_check(step)


func _is_held(input_name: String) -> bool:
	if InputMap.has_action(input_name):
		return Input.is_action_pressed(input_name)
	return Input.is_key_pressed(OS.find_keycode_from_string(input_name))


# An input action becomes an InputEventAction (it sets the action's state and reaches _input handlers);
# anything else is a key name, sent as a key event with both the logical and physical key code.
func _key(input_name: String, pressed: bool) -> void:
	if InputMap.has_action(input_name):
		var action := InputEventAction.new()
		action.action = input_name
		action.pressed = pressed
		action.strength = 1.0 if pressed else 0.0
		Input.parse_input_event(action)
		return
	var code := OS.find_keycode_from_string(input_name)
	var key := InputEventKey.new()
	key.keycode = code
	key.physical_keycode = code
	key.pressed = pressed
	if pressed and code >= 32 and code < 127:
		key.unicode = String.chr(code).to_lower().unicode_at(0)
	Input.parse_input_event(key)


# A click at (x, y) in window pixels: the pointer moves there, then the button goes down and up.
func _mouse(spec: Dictionary) -> void:
	var at := Vector2(float(spec.get("x", 0)), float(spec.get("y", 0)))
	var button_name := str(spec.get("button", "left"))
	var motion := InputEventMouseMotion.new()
	motion.position = at
	motion.global_position = at
	Input.parse_input_event(motion)
	for pressed in [true, false]:
		var click := InputEventMouseButton.new()
		click.button_index = MOUSE_BUTTONS.get(button_name, MOUSE_BUTTON_LEFT)
		click.button_mask = MOUSE_MASKS.get(button_name, MOUSE_BUTTON_MASK_LEFT) if pressed else 0
		click.position = at
		click.global_position = at
		click.pressed = pressed
		Input.parse_input_event(click)


func _check(step: Dictionary) -> void:
	var source := str(step.value)
	var record := {"step": int(step.get("n", 0)), "frame": frame, "expr": source, "passed": false, "value": null, "error": null}
	var expression := Expression.new()
	if expression.parse(_expand_node_paths(source), input_names) != OK:
		record.error = "Could not parse: %s" % expression.get_error_text()
	else:
		var value = expression.execute(input_values, current_scene, false)
		if expression.has_execute_failed():
			record.error = expression.get_error_text()
		else:
			record.value = _describe(value)
			record.passed = true if value else false
	checks.append(record)


# Expression has no $ syntax, so `$Square.position.x` becomes `get_node("Square").position.x`,
# and `$"Path/With Spaces"` becomes `get_node("Path/With Spaces")`. Text inside quotes is left alone.
func _expand_node_paths(source: String) -> String:
	var out := ""
	var i := 0
	var quote := ""
	while i < source.length():
		var c := source[i]
		if quote != "":
			out += c
			if c == "\\" and i + 1 < source.length():
				out += source[i + 1]
				i += 2
				continue
			if c == quote:
				quote = ""
			i += 1
			continue
		if c == "\"" or c == "'":
			quote = c
			out += c
			i += 1
			continue
		if c == "$" and i + 1 < source.length():
			var path := ""
			var next := source[i + 1]
			if next == "\"" or next == "'":
				var end := source.find(next, i + 2)
				if end < 0:
					end = source.length()
				path = source.substr(i + 2, end - i - 2)
				i = end + 1
			else:
				var j := i + 1
				while j < source.length() and (source[j] == "_" or source[j] == "/" or source[j] == "%" or source[j].is_valid_identifier() or source[j].is_valid_int()):
					j += 1
				path = source.substr(i + 1, j - i - 1)
				i = j
			out += "get_node(\"%s\")" % path.c_escape()
			continue
		out += c
		i += 1
	return out


func _describe(value) -> String:
	var text := str(value) if typeof(value) == TYPE_OBJECT else var_to_str(value)
	return text.substr(0, MAX_VALUE_CHARS)


func _problem(step_number: int, text: String) -> void:
	problems.append({"step": step_number, "text": text})


func _write_results() -> void:
	if results_path == "":
		return
	var file := FileAccess.open(results_path, FileAccess.WRITE)
	if file == null:
		printerr("EYES: could not write %s" % results_path)
		return
	file.store_string(JSON.stringify({"frames_run": frame + 1, "shots": shots, "checks": checks, "problems": problems, "focus_lost": focus_lost, "reapplied": reapplied}))
	file.close()


# Runs however Godot quits: at the last frame, when the game quits itself, or after a plan problem.
func _finalize() -> void:
	_write_results()
