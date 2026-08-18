.PHONY: install

install:
	npm --prefix resizify-webapp ci
	npm --prefix resizify-webapp run build
	go install .
