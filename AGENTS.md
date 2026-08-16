# Requirements

This is an image resizing utility which uses ImageMagick to resize images to specific ratios.
It lets the user select the ratios they want, and presents an interface where they can drag
and resize a rectangle which dictates how the image will be cropped (or expanded). The key
interface element is this resize box, which shows the picture and the resize rectangle. This
is called the editor. The editor can be zoomed and panned as well. The resize box is called
the frame.

The user uploads an image and the editor opens. They click save, and the image is output to
a directory. The user can close the image to upload a new one. That's it.

For the resizing itself, the application supports a configurable set of ratios. For now
these are supported:

4:3, 3:2, 16:9

Of course these should be able to be flipped to adjust to vertical images.

After the user uploads a picture, the closest dimensions for a cover fit (meaning the image
is cropped), are calculated. The user can change between various modes:

Toggles:

- Clamp to image: if unset, the frame can go beyond the image boundaries

Actions:

- Flip: flip the frame to be either horizontal or vertical
- Contain: resize the frame so it perfectly contains the full image
- Cover: resize the frame so the image covers it fully
- Center: Center the image within the frame without resizing it
- Save: save the image

- Allow 
- Uploading images
- Select between contain and cover modes
- Save result to directory

# Techstack

- Golang for the backend
- SolidJS for the frontend
- Tailwind for styling
- ImageMagick for image manipulation

# Coding guidelines

Don't write tests. Documentation isn't important.
