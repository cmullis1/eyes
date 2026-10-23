extends Node2D

# Writes user://probe.txt, so the tests can see where a run's user data goes.
func _ready() -> void:
	var file := FileAccess.open("user://probe.txt", FileAccess.WRITE)
	file.store_string("eyes probe")
	file.close()
