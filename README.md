# Resizify

Resizify is a small local web app for cropping images to common aspect ratios. It supports 1:1, 4:3, 3:2, and 16:9 frames, including portrait orientations.

## Requirements

- Go
- ImageMagick 7 (`magick` must be available on `PATH`)

## Usage

Start the app:

```sh
go run .
```

Open http://localhost:8080, upload an image, position the frame, and click **Save Image**. Finished images are written to the `output` directory.

Open the app in your default browser automatically:

```sh
go run . -open
```

Use a different port with:

```sh
go run . -port 3000 -open
```

Set a different output directory with the `RESIZIFY_OUTPUT_DIR` environment variable.

## License

Resizify is available under the [MIT License](LICENSE).
