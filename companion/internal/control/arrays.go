// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package control

import (
	"bytes"
	"encoding/json"
	"reflect"
	"unsafe"
)

// maxNormalizeDepth is far deeper than any control response nests.
const maxNormalizeDepth = 64

var marshalerType = reflect.TypeFor[json.Marshaler]()

// encodeJSON is compact JSON in which no array is ever null (contract
// v1.3): every nil slice is written as []. Values that marshal themselves,
// such as proxied server documents, are written as they are.
func encodeJSON(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(withEmptyArrays(reflect.ValueOf(value)).Interface()); err != nil {
		return nil, err
	}
	return bytes.TrimSpace(buffer.Bytes()), nil
}

// withEmptyArrays copies value with every nil slice made empty. Unexported
// fields, embedded ones included, cannot be rewritten and are kept as they
// were, so an embedded struct must be of an exported type.
func withEmptyArrays(value reflect.Value) reflect.Value {
	normalizer := emptyArrayNormalizer{visiting: map[visitedReference]bool{}}
	return normalizer.normalize(value, 0)
}

// visitedReference identifies a pointer, map or slice on the current path;
// slices sharing a backing array differ by length or type.
type visitedReference struct {
	address unsafe.Pointer
	typ     reflect.Type
	length  int
}

// emptyArrayNormalizer returns a cyclic or deeper-than-maxNormalizeDepth
// value unchanged, so encoding reports the cycle instead of the stack
// overflowing.
type emptyArrayNormalizer struct {
	visiting map[visitedReference]bool
}

func (n *emptyArrayNormalizer) normalize(value reflect.Value, depth int) reflect.Value {
	if !value.IsValid() {
		return reflect.ValueOf((*struct{})(nil))
	}
	if depth > maxNormalizeDepth || value.Type().Implements(marshalerType) && value.Kind() != reflect.Interface {
		return value
	}
	switch value.Kind() {
	case reflect.Pointer, reflect.Map, reflect.Slice:
		if value.IsNil() && value.Kind() != reflect.Slice {
			return value
		}
		// []byte marshals as a base64 string, not an array.
		if value.Kind() == reflect.Slice && value.Type().Elem().Kind() == reflect.Uint8 {
			return value
		}
		reference := visitedReference{address: value.UnsafePointer(), typ: value.Type()}
		if value.Kind() == reflect.Slice {
			reference.length = value.Len()
		}
		if reference.address != nil {
			if n.visiting[reference] {
				return value
			}
			n.visiting[reference] = true
			defer delete(n.visiting, reference)
		}
	}
	switch value.Kind() {
	case reflect.Pointer:
		copied := reflect.New(value.Type().Elem())
		copied.Elem().Set(n.normalize(value.Elem(), depth+1))
		return copied
	case reflect.Interface:
		if value.IsNil() {
			return value
		}
		copied := reflect.New(value.Type()).Elem()
		copied.Set(n.normalize(value.Elem(), depth+1))
		return copied
	case reflect.Struct:
		copied := reflect.New(value.Type()).Elem()
		copied.Set(value)
		for index := range value.NumField() {
			if value.Type().Field(index).IsExported() {
				copied.Field(index).Set(n.normalize(value.Field(index), depth+1))
			}
		}
		return copied
	case reflect.Slice:
		copied := reflect.MakeSlice(value.Type(), value.Len(), value.Len())
		for index := range value.Len() {
			copied.Index(index).Set(n.normalize(value.Index(index), depth+1))
		}
		return copied
	case reflect.Map:
		copied := reflect.MakeMapWithSize(value.Type(), value.Len())
		for entries := value.MapRange(); entries.Next(); {
			copied.SetMapIndex(entries.Key(), n.normalize(entries.Value(), depth+1))
		}
		return copied
	}
	return value
}
