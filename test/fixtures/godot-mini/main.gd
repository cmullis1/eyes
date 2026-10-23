extends Node2D

# Moves the square right while ui_right is held; the label counts frames, clicks and key presses.
const SPEED := 240.0

var frames := 0
var clicks := 0
var last_click := Vector2(-1, -1)
var space_presses := 0
var action_events := 0

func _process(delta: float) -> void:
	frames += 1
	if Input.is_action_pressed("ui_right"):
		$Square.position.x += SPEED * delta
	$Counter.text = "%d" % frames

func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventMouseButton and event.pressed and event.button_index == MOUSE_BUTTON_LEFT:
		clicks += 1
		Score.hits += 1
		last_click = event.position
	elif event is InputEventKey and event.pressed and not event.echo and event.keycode == KEY_SPACE:
		space_presses += 1
	elif event.is_action_pressed("ui_right"):
		action_events += 1
