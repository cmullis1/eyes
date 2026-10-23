extends Node2D

# A deliberate runtime error on the scene's third frame, for the Godot adapter's error test.
var frames := 0
var nothing = null

func _process(_delta: float) -> void:
	frames += 1
	if frames == 3:
		nothing.explode()
